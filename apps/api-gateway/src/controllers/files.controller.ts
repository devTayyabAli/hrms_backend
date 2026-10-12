import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  Inject,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  FileUploadDto,
  FileQueryDto,
  TenantOptional,
  Public,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
} from '@app/tenant-context';
import {
  MAX_UPLOAD_BYTES,
  sendFileResponse,
} from '../utils/file-response.helper';
import {
  assertFileAccess,
  FileAction,
  FileCaller,
  isSuperAdminCaller,
  RESERVED_UPLOAD_CATEGORIES,
  StoredFileMeta,
} from './file-access';

/**
 * The shared file store. Every route works from the caller's JWT — never a
 * header — to decide the tenant, and every read or delete is checked against
 * who uploaded the file and what the caller may see (see `file-access.ts`).
 */
@Controller('files')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@ApiBearerAuth()
export class FilesController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  /** 'platform' for a Super Admin; the JWT's tenant for everyone else. */
  private storeTenant(user: FileCaller): string {
    if (isSuperAdminCaller(user)) return 'platform';
    if (!user?.tenantId) {
      throw new ForbiddenException(
        'Your account is not linked to an organization.',
      );
    }
    return user.tenantId;
  }

  /** Loads the file's record (tenant-checked by the store), then applies the per-user rules. */
  private async authorize(
    fileId: string,
    user: FileCaller,
    action: FileAction,
  ) {
    const tenant = this.storeTenant(user);
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.GET_METADATA, {
        fileId,
        userTenantId: tenant,
      }),
    );
    const meta = result?.data as StoredFileMeta | undefined;
    if (!meta)
      throw new ForbiddenException(
        'You do not have permission to access this file.',
      );
    assertFileAccess(user, meta, action);
    return { tenant, meta: result.data };
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Post('upload')
  @ApiOperation({
    summary: 'Upload File to Centralized File Storage (S3 / Local)',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  // Super admins upload a profile photo before any tenant exists (initial
  // organization onboarding), so a tenant isn't required here — but the
  // tenant a file is filed under always comes from the JWT, never a header.
  @TenantOptional()
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: FileUploadDto,
    @CurrentUser() user: FileCaller,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided in form-data payload.');
    }
    const category = dto.category || 'general';
    if (RESERVED_UPLOAD_CATEGORIES.has(category)) {
      throw new BadRequestException(
        `Files can't be uploaded to '${category}'.`,
      );
    }

    return this.authClient.send(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
      file: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      tenantId: this.storeTenant(user),
      uploadedBy: user?.id || user?.sub || 'system',
      category,
      entityType: dto.entityType,
      entityId: dto.entityId,
      isPublic: dto.isPublic,
    });
  }

  // Registered ahead of `:fileId` — that param route would otherwise swallow
  // the literal `public` segment first, since NestJS matches routes in
  // declaration order.
  @ApiTags(TAGS.PLATFORM_FILES)
  @Get('public/:fileId')
  @Public()
  @ApiOperation({
    summary:
      'Download a Public File with No Authentication (avatars, logos). Images and PDFs render inline; any other type downloads as an attachment',
  })
  async downloadPublicFile(
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ) {
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_PUBLIC_FILE, {
        fileId,
      }),
    );

    if (result && result.buffer) {
      // This route is unauthenticated, so inline rendering is gated on the
      // stored MIME type being one browsers cannot be tricked into executing.
      return sendFileResponse(res, result, true);
    }

    return res.status(404).json({ message: 'File stream unavailable.' });
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Get(':fileId')
  @ApiOperation({ summary: 'Get File Metadata' })
  async getFileMetadata(
    @Param('fileId') fileId: string,
    @CurrentUser() user: FileCaller,
  ) {
    const { meta } = await this.authorize(fileId, user, 'read');
    // The storage key is an internal detail.
    const { storageKey: _storageKey, ...rest } = meta;
    return { success: true, data: rest };
  }

  /**
   * Always streams the binary back as an attachment. Use `GET :fileId/url`
   * for a presigned storage URL instead of bytes.
   */
  @ApiTags(TAGS.PLATFORM_FILES)
  @Get(':fileId/download')
  @ApiOperation({
    summary:
      'Download File Binary as an attachment (use GET :fileId/url for a presigned storage URL)',
  })
  async downloadFile(
    @Param('fileId') fileId: string,
    @CurrentUser() user: FileCaller,
    @Res() res: Response,
  ) {
    const { tenant } = await this.authorize(fileId, user, 'read');
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
        fileId,
        userTenantId: tenant,
      }),
    );

    if (result && result.buffer) {
      return sendFileResponse(res, result, false);
    }

    return res.status(404).json({ message: 'File stream unavailable.' });
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Get(':fileId/url')
  @ApiOperation({ summary: 'Get Short-lived Signed Access URL' })
  async getFileAccessUrl(
    @Param('fileId') fileId: string,
    @CurrentUser() user: FileCaller,
  ) {
    const { tenant } = await this.authorize(fileId, user, 'read');
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.GET_ACCESS_URL, {
        fileId,
        userTenantId: tenant,
      }),
    );
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Delete(':fileId')
  @ApiOperation({ summary: 'Delete File and Metadata' })
  async deleteFile(
    @Param('fileId') fileId: string,
    @CurrentUser() user: FileCaller,
  ) {
    const { tenant } = await this.authorize(fileId, user, 'delete');
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, {
        fileId,
        userTenantId: tenant,
      }),
    );
  }

  /** Listing every file is an administrator's view — not for ordinary users. */
  @ApiTags(TAGS.PLATFORM_FILES)
  @Get()
  @ApiOperation({
    summary:
      'Query Files by Category, EntityType or EntityId (Super Admin or organization admin)',
  })
  queryFiles(@Query() query: FileQueryDto, @CurrentUser() user: FileCaller) {
    const superAdmin = isSuperAdminCaller(user);
    if (
      !superAdmin &&
      !(user?.isFullAccess || user?.permissions?.includes('*'))
    ) {
      throw new ForbiddenException(
        'Only an organization administrator can list files.',
      );
    }
    return this.authClient.send(MESSAGE_PATTERNS.FILE.QUERY_FILES, {
      tenantId: this.storeTenant(user),
      category: query.category,
      entityType: query.entityType,
      entityId: query.entityId,
    });
  }
}
