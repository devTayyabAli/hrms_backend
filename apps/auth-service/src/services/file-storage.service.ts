import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/sequelize';
import * as path from 'path';
import * as crypto from 'crypto';
import { promises as fs, constants as fsConstants } from 'fs';
import { FileMetadata } from '../models';
import { FileStorageProvider } from '@app/common/interfaces/file-storage-provider.interface';
import { LocalStorageProvider } from '@app/common/providers/local-storage.provider';
import { S3StorageProvider } from '@app/common/providers/s3-storage.provider';

@Injectable()
export class FileStorageService implements OnModuleInit {
  private readonly logger = new Logger(FileStorageService.name);
  private activeProvider: FileStorageProvider;
  private providerType: 's3' | 'local' = 'local';

  private allowedMimeTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'application/json',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Platform database backup artifacts (BackupService writes gzipped JSON dumps).
    'application/gzip',
  ]);

  private maxFileSizeBytes = 10 * 1024 * 1024; // 10MB default

  /**
   * Categories whose files may be flagged `isPublic`.
   *
   * `isPublic` comes straight off the upload request, and a public file is
   * readable by anyone who has its id with no authentication whatsoever
   * (`GET /files/public/:fileId`). Taking that flag on trust meant any
   * authenticated user of any tenant could publish anything they could
   * upload — an employee contract, a payroll export, a database backup
   * artifact — to the open internet, in one request, with nothing to review
   * it and no audit of the decision.
   *
   * The flag exists for the cases where it is genuinely needed: avatars and
   * logos rendered by an `<img src>` that cannot attach a bearer token. Those
   * are the categories listed here. Everything else is stored private
   * regardless of what the request asks for, and remains reachable through
   * the authenticated download route.
   *
   * Additionally gated on MIME type: a "logo" is an image, and allowing an
   * arbitrary document type through under an image-shaped category would
   * defeat the point.
   */
  private static readonly PUBLIC_ELIGIBLE_CATEGORIES = new Set([
    'avatar',
    'profile',
    'logo',
    'branding',
  ]);

  private static readonly PUBLIC_ELIGIBLE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]);

  /**
   * Decides whether an upload may actually be public, independent of what the
   * caller asked for. Returns false rather than throwing: the upload itself
   * is legitimate, only the publishing is refused, and failing the whole
   * request would break callers that set the flag speculatively.
   */
  private resolveIsPublic(
    requested: boolean | undefined,
    category: string,
    mimeType: string,
  ): boolean {
    if (!requested) return false;

    const eligible =
      FileStorageService.PUBLIC_ELIGIBLE_CATEGORIES.has(category) &&
      FileStorageService.PUBLIC_ELIGIBLE_MIME_TYPES.has(mimeType);

    if (!eligible) {
      this.logger.warn(
        `Refused public visibility for an upload in category '${category}' (${mimeType}); stored as private.`,
      );
    }

    return eligible;
  }

  /**
   * `LocalStorageProvider.getSignedUrl()` points at `files/download-local`, a
   * route that was never implemented — every locally-stored file's
   * `accessUrl` 404d. `GET files/:fileId/download` is real, but it sits
   * behind `JwtAuthGuard` — an `<img src>`/`next/image` request can't attach
   * a Bearer token, so that 401s instead. `GET files/public/:fileId` is the
   * unauthenticated route made for exactly this (gated server-side on the
   * record's own `isPublic` flag, not on the caller). S3's presigned URLs are
   * real and already hotlinkable, so they pass through unchanged. Relative to
   * the gateway's own origin — callers resolve it from there.
   */
  private async resolveAccessUrl(
    storageKey: string,
    fileId: string,
  ): Promise<string> {
    if (this.providerType === 'local') {
      return `/files/public/${fileId}`;
    }
    return this.activeProvider.getSignedUrl(storageKey);
  }

  constructor(
    private readonly configService: ConfigService,
    @InjectModel(FileMetadata) private readonly fileMetadataModel: typeof FileMetadata,
  ) {}

  async onModuleInit() {
    const s3Key = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const s3Secret = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
    const s3Bucket = this.configService.get<string>('AWS_S3_BUCKET');
    const s3Region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    const s3Endpoint = this.configService.get<string>('AWS_S3_ENDPOINT');
    const providerOverride = this.configService.get<string>('STORAGE_PROVIDER');

    if ((providerOverride === 's3' || (!providerOverride && s3Key && s3Bucket)) && s3Key && s3Secret && s3Bucket) {
      this.activeProvider = new S3StorageProvider({
        accessKeyId: s3Key,
        secretAccessKey: s3Secret,
        region: s3Region,
        bucket: s3Bucket,
        endpoint: s3Endpoint,
      });
      this.providerType = 's3';
      this.logger.log(`FileStorageService initialized with AWS S3 provider (Bucket: ${s3Bucket}).`);
    } else {
      const localPath = this.configService.get<string>('LOCAL_STORAGE_PATH', './uploads');
      this.activeProvider = new LocalStorageProvider(localPath);
      this.providerType = 'local';
      this.logger.log(`FileStorageService initialized with Local Folder provider (Path: ${localPath}).`);
    }
  }

  /**
   * Upload file, store binary in S3/Local, and record metadata in database
   */
  async uploadFile(
    file: { buffer: Buffer; originalname: string; mimetype: string; size?: number },
    payload: {
      tenantId?: string;
      uploadedBy: string;
      category?: string;
      entityType?: string;
      entityId?: string;
      isPublic?: boolean;
    },
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('No file buffer provided for upload.');
    }

    const fileSize = file.size || file.buffer.length;
    if (fileSize > this.maxFileSizeBytes) {
      throw new BadRequestException(`File size exceeds maximum allowed limit of ${this.maxFileSizeBytes / (1024 * 1024)}MB.`);
    }

    if (!this.allowedMimeTypes.has(file.mimetype)) {
      throw new BadRequestException(`File MIME type '${file.mimetype}' is not permitted.`);
    }

    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    const safeExt = ext.replace(/[^a-z0-9.]/g, '');
    const tenantFolder = payload.tenantId ? `tenant_${payload.tenantId}` : 'platform';
    const categoryFolder = (payload.category || 'general').replace(/[^a-z0-9_-]/gi, '');
    const randomName = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${safeExt}`;
    const storageKey = `${tenantFolder}/${categoryFolder}/${randomName}`;

    // Decided here, not taken from the request — see resolveIsPublic. Both
    // the storage provider's own ACL and the metadata row below use this
    // value, so they cannot disagree about whether the object is published.
    const isPublic = this.resolveIsPublic(
      payload.isPublic,
      payload.category || 'general',
      file.mimetype,
    );

    const uploadResult = await this.activeProvider.uploadFile(
      file.buffer,
      storageKey,
      file.mimetype,
      { isPublic },
    );

    const record = await this.fileMetadataModel.create({
      tenantId: payload.tenantId || 'platform',
      uploadedBy: payload.uploadedBy,
      originalName: file.originalname,
      storageKey: uploadResult.storageKey,
      storageProvider: uploadResult.storageProvider,
      mimeType: file.mimetype,
      extension: safeExt,
      size: fileSize,
      category: payload.category || 'general',
      entityType: payload.entityType || null,
      entityId: payload.entityId || null,
      isPublic,
    });

    const accessUrl = await this.resolveAccessUrl(storageKey, record.id);

    return {
      success: true,
      message: 'File uploaded successfully',
      data: {
        id: record.id,
        originalName: record.originalName,
        storageKey: record.storageKey,
        storageProvider: record.storageProvider,
        mimeType: record.mimeType,
        size: record.size,
        accessUrl,
      },
    };
  }

  /**
   * Get file metadata record
   */
  async getFileMetadata(fileId: string, userTenantId?: string) {
    const record = await this.fileMetadataModel.findByPk(fileId);
    if (!record) {
      throw new NotFoundException(`File metadata record not found: ${fileId}`);
    }

    this.verifyTenantAccess(record, userTenantId);

    const accessUrl = await this.resolveAccessUrl(record.storageKey, record.id);

    return {
      success: true,
      data: {
        ...record.get({ plain: true }),
        accessUrl,
      },
    };
  }

  /**
   * Download binary file content
   */
  async downloadFile(fileId: string, userTenantId?: string) {
    const record = await this.fileMetadataModel.findByPk(fileId);
    if (!record) {
      throw new NotFoundException(`File record not found: ${fileId}`);
    }

    this.verifyTenantAccess(record, userTenantId);

    const buffer = await this.activeProvider.downloadFile(record.storageKey);
    return {
      buffer,
      originalName: record.originalName,
      mimeType: record.mimeType,
    };
  }

  /**
   * Download binary content for a file marked public, with no auth at all —
   * the gateway route this backs has no `JwtAuthGuard`, so this method is the
   * only thing standing between "public" and every file on the platform.
   */
  async downloadPublicFile(fileId: string) {
    const record = await this.fileMetadataModel.findByPk(fileId);
    if (!record) {
      throw new NotFoundException(`File record not found: ${fileId}`);
    }
    if (!record.isPublic) {
      throw new ForbiddenException(`File ${fileId} is not public.`);
    }

    const buffer = await this.activeProvider.downloadFile(record.storageKey);
    return {
      buffer,
      originalName: record.originalName,
      mimeType: record.mimeType,
    };
  }

  /**
   * Delete file and database metadata
   */
  async deleteFile(fileId: string, userTenantId?: string) {
    const record = await this.fileMetadataModel.findByPk(fileId);
    if (!record) {
      throw new NotFoundException(`File record not found: ${fileId}`);
    }

    this.verifyTenantAccess(record, userTenantId);

    await this.activeProvider.deleteFile(record.storageKey);
    await record.destroy();

    return {
      success: true,
      message: `File ${fileId} deleted successfully.`,
    };
  }

  /**
   * Get temporary signed access URL
   */
  async getFileAccessUrl(fileId: string, userTenantId?: string) {
    const record = await this.fileMetadataModel.findByPk(fileId);
    if (!record) {
      throw new NotFoundException(`File record not found: ${fileId}`);
    }

    this.verifyTenantAccess(record, userTenantId);

    const url = await this.resolveAccessUrl(record.storageKey, record.id);
    return {
      success: true,
      url,
    };
  }

  /**
   * Query files by tenant, category, entityType, or entityId
   */
  async queryFiles(payload: {
    tenantId?: string;
    category?: string;
    entityType?: string;
    entityId?: string;
  }) {
    const where: any = {};
    if (payload.tenantId) where.tenantId = payload.tenantId;
    if (payload.category) where.category = payload.category;
    if (payload.entityType) where.entityType = payload.entityType;
    if (payload.entityId) where.entityId = payload.entityId;

    const files = await this.fileMetadataModel.findAll({ where });
    return {
      success: true,
      data: files,
    };
  }

  /**
   * Byte totals per storage category for the Overview tab's Storage
   * breakdown. Backup artifacts are uploaded under the 'backups' category
   * (see BackupService), so they're reported separately from user files.
   */
  async getStorageBreakdown(): Promise<{ filesBytes: number; backupsBytes: number }> {
    const rows = await this.fileMetadataModel.findAll({ attributes: ['category', 'size'] });

    let filesBytes = 0;
    let backupsBytes = 0;
    for (const row of rows) {
      const size = Number(row.size) || 0;
      if (row.category === 'backups') backupsBytes += size;
      else filesBytes += size;
    }

    return { filesBytes, backupsBytes };
  }

  /**
   * Health of the configured storage backend for the Overview tab's "File
   * Storage" card. For local storage this actually touches the filesystem;
   * for S3 it confirms the provider was constructed from real credentials at
   * boot (a full round-trip to the bucket on every dashboard load would be a
   * poor trade).
   */
  async checkHealth(): Promise<{ status: 'up' | 'down'; provider: string; error?: string }> {
    if (!this.activeProvider) {
      return { status: 'down', provider: this.providerType, error: 'Storage provider is not initialised.' };
    }

    if (this.providerType === 'local') {
      const localPath = this.configService.get<string>('LOCAL_STORAGE_PATH', './uploads');
      try {
        await fs.mkdir(localPath, { recursive: true });
        await fs.access(localPath, fsConstants.W_OK);
      } catch (err: any) {
        return { status: 'down', provider: 'local', error: err.message };
      }
    }

    return { status: 'up', provider: this.providerType };
  }

  /**
   * Enforce tenant isolation rules
   */
  private verifyTenantAccess(record: FileMetadata, userTenantId?: string) {
    if (!userTenantId || userTenantId === 'platform') {
      return; // Platform SuperAdmin bypasses tenant check
    }

    if (record.tenantId !== 'platform' && record.tenantId !== userTenantId) {
      throw new ForbiddenException('Tenant Access Denied: You do not have permission to access this file.');
    }
  }
}
