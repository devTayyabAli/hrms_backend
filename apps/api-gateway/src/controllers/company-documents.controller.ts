import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  CreateCompanyDocumentDto,
  GetCompanyDocumentsQueryDto,
  UpdateCompanyDocumentDto,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
  CurrentUser,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * Workspace › Documents: the company library. Upload the file through
 * `files/upload` first, then create the document with the returned id.
 * Update and delete return the id of a file that is no longer referenced
 * (`previousFileId` / `fileId`) for the client to remove from the store.
 */
@Controller('organization/documents')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_WORKSPACE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.DOCUMENTS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class CompanyDocumentsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.VIEW)
  @RequirePermissions('documents.view', 'documents.manage')
  @ApiOperation({ summary: 'The company library, filterable by category, status and search, with KPI counts' })
  getDocuments(@Headers('x-tenant-id') tenantId: string, @Query() query: GetCompanyDocumentsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.COMPANY_DOCUMENT.GET_ALL, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.CREATE)
  @RequirePermissions('documents.create', 'documents.manage')
  @ApiOperation({ summary: 'Add a document (file uploaded first via files/upload)' })
  createDocument(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateCompanyDocumentDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.COMPANY_DOCUMENT.CREATE, { tenantId, dto, actorUserId });
  }

  @Patch(':documentId')
  @RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.EDIT)
  @RequirePermissions('documents.edit', 'documents.manage')
  @ApiOperation({ summary: 'Edit a document, optionally replacing its file' })
  updateDocument(
    @Headers('x-tenant-id') tenantId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: UpdateCompanyDocumentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.COMPANY_DOCUMENT.UPDATE, { tenantId, documentId, dto });
  }

  @Delete(':documentId')
  @RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.DELETE)
  @RequirePermissions('documents.delete', 'documents.manage')
  @ApiOperation({ summary: 'Delete a document' })
  deleteDocument(@Headers('x-tenant-id') tenantId: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.COMPANY_DOCUMENT.DELETE, { tenantId, documentId });
  }
}
