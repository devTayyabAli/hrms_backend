import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { FileStorageProvider, StorageUploadResult } from '../interfaces/file-storage-provider.interface';

@Injectable()
export class LocalStorageProvider implements FileStorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly basePath: string;

  constructor(customBasePath?: string) {
    this.basePath = path.resolve(customBasePath || process.env.LOCAL_STORAGE_PATH || './uploads');
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private resolveSafePath(key: string): string {
    const normalizedKey = path.normalize(key).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.resolve(this.basePath, normalizedKey);
    if (!fullPath.startsWith(this.basePath)) {
      throw new BadRequestException('Security Violation: Invalid file path traversal attempt.');
    }
    return fullPath;
  }

  async uploadFile(
    fileBuffer: Buffer,
    key: string,
    mimeType: string,
    options?: { isPublic?: boolean },
  ): Promise<StorageUploadResult> {
    const targetPath = this.resolveSafePath(key);
    const dir = path.dirname(targetPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await fs.promises.writeFile(targetPath, fileBuffer);
    this.logger.log(`Local file saved at: ${targetPath}`);

    return {
      storageKey: key,
      storageProvider: 'local',
      mimeType,
      size: fileBuffer.length,
    };
  }

  async downloadFile(key: string): Promise<Buffer> {
    const targetPath = this.resolveSafePath(key);
    if (!fs.existsSync(targetPath)) {
      throw new NotFoundException(`File not found at storage key: ${key}`);
    }
    return fs.promises.readFile(targetPath);
  }

  async deleteFile(key: string): Promise<boolean> {
    const targetPath = this.resolveSafePath(key);
    if (fs.existsSync(targetPath)) {
      await fs.promises.unlink(targetPath);
      return true;
    }
    return false;
  }

  async fileExists(key: string): Promise<boolean> {
    const targetPath = this.resolveSafePath(key);
    return fs.existsSync(targetPath);
  }

  async getSignedUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    return `/api/v1/files/download-local?key=${encodeURIComponent(key)}`;
  }
}
