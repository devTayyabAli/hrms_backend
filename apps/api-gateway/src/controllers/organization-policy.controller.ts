import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Inject,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  PolicyType,
  PolicyStatus,
  PolicySource,
  CreateOrganizationPolicyDto,
  UpdateOrganizationPolicyDto,
  ActivatePolicyDto,
  CreateNewPolicyVersionDto,
} from '@app/common';

import { UseGuards } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
} from '@app/tenant-context';

@Controller('organization/policies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.SETTINGS)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class OrganizationPolicyController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // COLLECTION OPERATIONS
  // ==========================================

  @ApiTags(TAGS.ORG_POLICIES)
  @Get()
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({
    summary: 'List organization policies',
    description: 'Returns all policies for the organization. Filterable by policyType, status, and source.',
  })
  @ApiQuery({ name: 'policyType', enum: PolicyType, required: false })
  @ApiQuery({ name: 'status', enum: PolicyStatus, required: false })
  @ApiQuery({ name: 'source', enum: PolicySource, required: false })
  getPolicies(
    @Headers('x-tenant-id') tenantId: string,
    @Query('policyType') policyType?: PolicyType,
    @Query('status') status?: PolicyStatus,
    @Query('source') source?: PolicySource,
  ) {
    const query = { policyType, status, source };
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ALL, { tenantId, query });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Post()
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Create a new organization policy',
    description: 'Creates a policy in DRAFT status. Configuration is validated against the policy type schema.',
  })
  createPolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateOrganizationPolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.CREATE, { tenantId, dto });
  }

  // ==========================================
  // ACTIVE POLICY LOOKUP (before /:id to avoid route conflict)
  // ==========================================

  @ApiTags(TAGS.ORG_POLICIES)
  @Get('active/:policyType')
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({
    summary: 'Get the currently applicable active policy for a given type',
    description:
      'Returns the ACTIVE policy for the given policyType, considering effectiveFrom/effectiveTo dates. Returns null if no active policy found.',
  })
  @ApiParam({ name: 'policyType', enum: PolicyType })
  getActivePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('policyType') policyType: PolicyType,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ACTIVE, {
      tenantId,
      policyType,
    });
  }

  // ==========================================
  // SINGLE RESOURCE OPERATIONS
  // ==========================================

  @ApiTags(TAGS.ORG_POLICIES)
  @Get(':id')
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({ summary: 'Get a policy by ID' })
  getPolicyById(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_ONE, { tenantId, policyId });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Patch(':id')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Update a policy',
    description: 'Only DRAFT and INACTIVE policies can be updated. ACTIVE policies must be deactivated first, or create a new version.',
  })
  updatePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
    @Body() dto: UpdateOrganizationPolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.UPDATE, { tenantId, policyId, dto });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Delete(':id')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Delete a policy',
    description: 'Only DRAFT policies can be deleted. Use /archive for other statuses.',
  })
  deletePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.DELETE, { tenantId, policyId });
  }

  // ==========================================
  // LIFECYCLE TRANSITIONS
  // ==========================================

  @ApiTags(TAGS.ORG_POLICIES)
  @Post(':id/activate')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Activate a policy',
    description:
      'Transitions policy from DRAFT or INACTIVE to ACTIVE. For exclusive policy types (ATTENDANCE, OVERTIME, REMOTE_WORK, PAYROLL), any currently ACTIVE policy of the same type is automatically deactivated.',
  })
  activatePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
    @Body() dto: ActivatePolicyDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.ACTIVATE, {
      tenantId,
      policyId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Post(':id/deactivate')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Deactivate a policy',
    description: 'Transitions policy from ACTIVE to INACTIVE.',
  })
  deactivatePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.DEACTIVATE, { tenantId, policyId });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Post(':id/archive')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Archive a policy',
    description: 'Permanently archives a policy. DRAFT, ACTIVE, and INACTIVE policies can be archived. Archived policies cannot be modified.',
  })
  archivePolicy(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.ARCHIVE, { tenantId, policyId });
  }

  // ==========================================
  // VERSIONING
  // ==========================================

  @ApiTags(TAGS.ORG_POLICIES)
  @Get(':id/versions')
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({
    summary: 'Get the version history chain for a policy',
    description: 'Returns the full version chain from the current policy back to the original (v1), following previousVersionId links.',
  })
  getPolicyVersions(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.GET_VERSIONS, { tenantId, policyId });
  }

  @ApiTags(TAGS.ORG_POLICIES)
  @Post(':id/new-version')
  @RequirePermissions('settings.manage')
  @ApiOperation({
    summary: 'Create a new version of an existing policy',
    description:
      'Clones the policy with version incremented by 1, previousVersionId set to current. New version starts as DRAFT. The existing version remains unchanged.',
  })
  createNewVersion(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') policyId: string,
    @Body() dto: CreateNewPolicyVersionDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION_POLICY.CREATE_VERSION, {
      tenantId,
      policyId,
      dto,
    });
  }
}
