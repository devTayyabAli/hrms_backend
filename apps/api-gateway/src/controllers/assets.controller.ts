import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import {
  AssetNoteDto,
  AssignAssetDto,
  CreateAssetCategoryDto,
  CreateAssetDto,
  DisposeAssetDto,
  ExportAssetsQueryDto,
  GetAssetsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateAssetCategoryDto,
  UpdateAssetDto,
  type CsvColumn,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  OrganizationModuleGuard,
  PermissionsGuard,
  RequireModule,
  RequirePermissions,
  RolesGuard,
  TenantGuard,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { sendCsvExport } from '../utils/csv-export.helper';

type AssetExportRow = {
  assetCode: string;
  name: string;
  category: { name: string } | null;
  brand: string | null;
  serialNumber: string | null;
  status: string;
  assignedTo: { name: string; employeeCode: string | null } | null;
  assignedAt: Date | null;
  purchaseDate: string | null;
  purchaseCost: number | null;
  warrantyExpiry: string | null;
  vendor: string | null;
  location: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  AVAILABLE: 'Available',
  IN_USE: 'In Use',
  MAINTENANCE: 'In Maintenance',
  DISPOSED: 'Disposed',
};

const ASSET_CSV_COLUMNS: CsvColumn<AssetExportRow>[] = [
  { header: 'Asset Code', value: (row) => row.assetCode },
  { header: 'Asset Name', value: (row) => row.name },
  { header: 'Category', value: (row) => row.category?.name ?? '' },
  { header: 'Brand', value: (row) => row.brand ?? '' },
  { header: 'Serial Number', value: (row) => row.serialNumber ?? '' },
  { header: 'Status', value: (row) => STATUS_LABEL[row.status] ?? row.status },
  { header: 'Assigned To', value: (row) => row.assignedTo?.name ?? '' },
  { header: 'Employee Code', value: (row) => row.assignedTo?.employeeCode ?? '' },
  { header: 'Assigned On', value: (row) => (row.assignedAt ? new Date(row.assignedAt).toISOString().slice(0, 10) : '') },
  { header: 'Purchase Date', value: (row) => row.purchaseDate ?? '' },
  { header: 'Purchase Cost', value: (row) => row.purchaseCost ?? '' },
  { header: 'Warranty Expiry', value: (row) => row.warrantyExpiry ?? '' },
  { header: 'Vendor', value: (row) => row.vendor ?? '' },
  { header: 'Location', value: (row) => row.location ?? '' },
];

/**
 * Assets (organization portal): the organization's equipment register — the
 * summary cards and status donut, the Categories panel, the asset table, and
 * the actions that move an asset between Available, In Use, Maintenance and
 * Disposed.
 *
 * Assets belong to the organization, not to a team, so there is no data scope:
 * anyone with the permission sees the whole register. "Which employee" in the
 * assign dialog comes from the existing employee list.
 */
@Controller('organization/assets')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_ASSETS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.ASSETS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class AssetsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  /** Who is acting, for the asset's history. */
  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  // Static routes are declared before the `:assetId` ones so they are never read as an id.

  @Get('summary')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
  @RequirePermissions('assets.view', 'assets.manage')
  @ApiOperation({ summary: 'Page header: the four cards (with change since last month), the status donut and the Categories panel' })
  getSummary(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_SUMMARY, { tenantId });
  }

  @Get('categories')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
  @RequirePermissions('assets.view', 'assets.manage')
  @ApiOperation({ summary: 'Asset categories with how many assets each holds (also the category picker)' })
  getCategories(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_CATEGORIES, { tenantId });
  }

  @Post('categories')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.CREATE)
  @RequirePermissions('assets.create', 'assets.manage')
  @ApiOperation({ summary: 'Add an asset category' })
  createCategory(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateAssetCategoryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.CREATE_CATEGORY, { ...this.actor(tenantId, userId, email), dto });
  }

  @Patch('categories/:categoryId')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'categoryId' })
  @ApiOperation({ summary: 'Rename an asset category or change its icon' })
  updateCategory(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateAssetCategoryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.UPDATE_CATEGORY, { ...this.actor(tenantId, userId, email), categoryId, dto });
  }

  @Delete('categories/:categoryId')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.DELETE)
  @RequirePermissions('assets.delete', 'assets.manage')
  @ApiParam({ name: 'categoryId' })
  @ApiOperation({ summary: 'Delete an asset category — only when no asset uses it' })
  deleteCategory(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.DELETE_CATEGORY, { ...this.actor(tenantId, userId, email), categoryId });
  }

  @Get('export')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EXPORT)
  @RequirePermissions('assets.export', 'assets.manage')
  @ApiOperation({ summary: 'Export the filtered asset register as CSV' })
  async exportAssets(@Headers('x-tenant-id') tenantId: string, @Query() query: ExportAssetsQueryDto, @Res({ passthrough: true }) res: Response) {
    return sendCsvExport<AssetExportRow>(res, this.tenantClient, MESSAGE_PATTERNS.ASSET.EXPORT, { tenantId, query }, 'assets', ASSET_CSV_COLUMNS);
  }

  @Get()
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
  @RequirePermissions('assets.view', 'assets.manage')
  @ApiOperation({ summary: 'Asset List — search, filter by category / status / holder, sort, page' })
  getAssets(@Headers('x-tenant-id') tenantId: string, @Query() query: GetAssetsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_ALL, { tenantId, query });
  }

  @Post()
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.CREATE)
  @RequirePermissions('assets.create', 'assets.manage')
  @ApiOperation({ summary: 'Add Asset — optionally giving it to an employee straight away' })
  createAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateAssetDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.CREATE, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get(':assetId')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
  @RequirePermissions('assets.view', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'One asset with its full details and history' })
  getAsset(@Headers('x-tenant-id') tenantId: string, @Param('assetId', ParseUUIDPipe) assetId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_ONE, { tenantId, assetId });
  }

  @Patch(':assetId')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Edit an asset\'s details (not its status or holder — use the actions for those)' })
  updateAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.UPDATE, { ...this.actor(tenantId, userId, email), assetId, dto });
  }

  @Delete(':assetId')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.DELETE)
  @RequirePermissions('assets.delete', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Delete an asset — not while someone has it' })
  deleteAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.DELETE, { ...this.actor(tenantId, userId, email), assetId });
  }

  @Post(':assetId/assign')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Give the asset to an employee (it becomes In Use). If someone else had it, it is taken from them' })
  assignAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: AssignAssetDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.ASSIGN, { ...this.actor(tenantId, userId, email), assetId, dto });
  }

  @Post(':assetId/return')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'The employee hands the asset back (it becomes Available)' })
  returnAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: AssetNoteDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.RETURN, { ...this.actor(tenantId, userId, email), assetId, dto });
  }

  @Post(':assetId/maintenance')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Send the asset for maintenance. It keeps its holder' })
  startMaintenance(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: AssetNoteDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.START_MAINTENANCE, { ...this.actor(tenantId, userId, email), assetId, dto });
  }

  @Post(':assetId/maintenance/complete')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Maintenance is done: In Use again if it has a holder, otherwise Available' })
  completeMaintenance(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: AssetNoteDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.COMPLETE_MAINTENANCE, { ...this.actor(tenantId, userId, email), assetId, dto });
  }

  @Post(':assetId/dispose')
  @RequireModule(HRMSModuleKey.ASSETS, ModuleAction.EDIT)
  @RequirePermissions('assets.edit', 'assets.manage')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Dispose of the asset. Final: nobody has it afterwards and it cannot be changed' })
  disposeAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: DisposeAssetDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.DISPOSE, { ...this.actor(tenantId, userId, email), assetId, dto });
  }
}
