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
  CurrentTenant,
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
} from '@app/tenant-context';
import {
  MAX_UPLOAD_BYTES,
  sendFileResponse,
} from '../utils/file-response.helper';

@Controller('files')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
@ApiBearerAuth()
export class FilesController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

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
  // organization onboarding) — a tenant-scoped caller's tenantId still comes
  // through via `CurrentTenant`'s JWT fallback, so this only relaxes the
  // requirement for callers that genuinely have none.
  @TenantOptional()
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: FileUploadDto,
    @CurrentUser('id') userId: string,
    @CurrentTenant('tenantId') tenantId: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided in form-data payload.');
    }

    return this.authClient.send(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
      file: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      tenantId: tenantId || 'platform',
      uploadedBy: userId || 'system',
      category: dto.category || 'general',
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
  getFileMetadata(
    @Param('fileId') fileId: string,
    @CurrentTenant('tenantId') tenantId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.FILE.GET_METADATA, {
      fileId,
      userTenantId: tenantId || 'platform',
    });
  }

  /**
   * Always streams the binary back as an attachment.
   *
   * The summary previously promised a redirect to a presigned storage URL,
   * which this route has never done — `FileStorageService.downloadFile`
   * returns `{ buffer, originalName, mimeType }` for every provider, S3
   * included. Callers that want a URL instead of bytes want
   * `GET :fileId/url`, which is what actually issues signed URLs. The claim
   * is dropped rather than implemented so the two routes stay distinct.
   *
   * Note this materializes the whole file in gateway memory, because the RPC
   * contract hands over a complete buffer. Acceptable at the 10MB upload
   * ceiling; anything larger should move to presigned URLs end to end rather
   * than grow this path.
   */
  @ApiTags(TAGS.PLATFORM_FILES)
  @Get(':fileId/download')
  @ApiOperation({
    summary:
      'Download File Binary as an attachment (use GET :fileId/url for a presigned storage URL)',
  })
  async downloadFile(
    @Param('fileId') fileId: string,
    @CurrentTenant('tenantId') tenantId: string,
    @Res() res: Response,
  ) {
    const result: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
        fileId,
        userTenantId: tenantId || 'platform',
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
  getFileAccessUrl(
    @Param('fileId') fileId: string,
    @CurrentTenant('tenantId') tenantId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.FILE.GET_ACCESS_URL, {
      fileId,
      userTenantId: tenantId || 'platform',
    });
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Delete(':fileId')
  @ApiOperation({ summary: 'Delete File and Metadata' })
  deleteFile(
    @Param('fileId') fileId: string,
    @CurrentTenant('tenantId') tenantId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, {
      fileId,
      userTenantId: tenantId || 'platform',
    });
  }

  @ApiTags(TAGS.PLATFORM_FILES)
  @Get()
  @ApiOperation({ summary: 'Query Files by Category, EntityType or EntityId' })
  queryFiles(
    @Query() query: FileQueryDto,
    @CurrentTenant('tenantId') tenantId: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.FILE.QUERY_FILES, {
      tenantId: tenantId || 'platform',
      category: query.category,
      entityType: query.entityType,
      entityId: query.entityId,
    });
  }
}
