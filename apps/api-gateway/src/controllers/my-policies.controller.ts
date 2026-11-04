import { Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { GetMyPoliciesQueryDto, HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, SERVICES } from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * My Policies (employee portal): the company documents meant for the
 * signed-in employee, and acknowledging the ones that ask for it.
 *
 * Like the rest of `organization/me`, everything is the caller's own: the
 * employee linked to the login. There is no permission to check. A document
 * that was sent to other people is simply not found. The Documents module
 * still has to be enabled for the organization.
 */
@Controller('organization/me/policies')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyPoliciesController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'My Policies: published documents meant for me, those waiting for my acknowledgement first' })
  getMine(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyPoliciesQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.POLICY_ACK.GET_MINE, { tenantId, userId, email, query });
  }

  @Post(':documentId/acknowledge')
  @ApiParam({ name: 'documentId' })
  @ApiOperation({ summary: 'I have read it and accept it. Doing it again changes nothing' })
  acknowledge(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.POLICY_ACK.ACKNOWLEDGE, { tenantId, userId, email, documentId });
  }
}
