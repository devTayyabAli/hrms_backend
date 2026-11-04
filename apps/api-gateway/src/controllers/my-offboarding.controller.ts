import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { HRMSModuleKey, MESSAGE_PATTERNS, ModuleAction, ClearMyOffboardingDto, SERVICES } from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * The reporting manager's part of an offboarding. Like the rest of
 * `organization/me` it is the caller's own: there is no permission to check,
 * and a case for someone who does not report to the caller is simply not found.
 */
@Controller('organization/me/offboarding')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyOffboardingController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'Offboardings where something is wanted from me: my clearance as a reporting manager, and department steps that are mine. Each says which in waitingOnMe' })
  getWaiting(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.GET_WAITING_ON_ME, { tenantId, userId, email });
  }

  @Post(':caseId/clear')
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'Clear my part: this person has nothing outstanding with me. stage defaults to MANAGER; send a department step key (DEPT-1 ...) to clear that' })
  clear(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ClearMyOffboardingDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.CLEAR_AS_MANAGER, { tenantId, userId, email, caseId, dto });
  }
}
