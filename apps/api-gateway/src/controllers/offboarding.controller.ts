import { BadRequestException, Body, Controller, Get, Headers, Inject, Injectable, Param, ParseUUIDPipe, PipeTransform, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  CancelOffboardingDto,
  GetOffboardingCasesQueryDto,
  HRMSModuleKey,
  InitiateOffboardingDto,
  MESSAGE_PATTERNS,
  ModuleAction,
  OffboardingNoteDto,
  OffboardingStage,
  SERVICES,
  UpdateOffboardingDto,
  UpdateOffboardingSettingsDto,
} from '@app/common';
import { JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

// Finance clears its own part with its payroll grant, so it can read and clear without the HR one.
/** A standard stage, or a step the person's department added (DEPT-1, DEPT-2 ...). */
@Injectable()
export class ParseStagePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if ((Object.values(OffboardingStage) as string[]).includes(value) || /^DEPT-\d{1,3}$/.test(value)) return value;
    throw new BadRequestException('Use MANAGER, HR, IT, FINANCE, or a department step such as DEPT-1.');
  }
}

const VIEW = ['offboarding.view', 'offboarding.manage', 'payroll.adjustments.manage', 'payroll.manage'];
const MANAGE = ['offboarding.manage'];
const CLEAR = ['offboarding.manage', 'payroll.adjustments.manage', 'payroll.manage'];

/**
 * Offboarding: one case for each person leaving, and each department's
 * clearance that they have nothing outstanding. The reporting manager clears
 * their part through `organization/me/offboarding`; IT's clearance is read
 * from the asset clearance and cannot be given here.
 */
@Controller('organization/offboarding')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_ONBOARDING)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class OffboardingController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // Static routes are declared before the `cases/:caseId` ones so they are never read as an id.

  @Get('settings')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions(...VIEW, 'settings.view', 'settings.manage')
  @ApiOperation({ summary: 'Whether leaving needs every clearance, and which clearances a case asks for' })
  getSettings(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.GET_SETTINGS, { tenantId });
  }

  @Put('settings')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions(...MANAGE, 'settings.manage')
  @ApiOperation({ summary: 'Turn the leaving gate on or off, and choose the clearances (manager, HR, IT, Finance)' })
  updateSettings(@Headers('x-tenant-id') tenantId: string, @Body() dto: UpdateOffboardingSettingsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.UPDATE_SETTINGS, { tenantId, dto });
  }

  @Get('cases')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiOperation({ summary: 'Offboarding cases for the people you can reach, open ones by default, with each clearance' })
  getCases(@Headers('x-tenant-id') tenantId: string, @Query() query: GetOffboardingCasesQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.GET_CASES, { tenantId, query });
  }

  @Post('cases')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.CREATE)
  @RequirePermissions(...MANAGE)
  @ApiOperation({ summary: 'Start offboarding for someone who works here. Their manager is asked to clear their part' })
  initiate(@Headers('x-tenant-id') tenantId: string, @Body() dto: InitiateOffboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.INITIATE, { tenantId, dto });
  }

  @Get('cases/:caseId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions(...VIEW)
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'One case: clearances, the assets they still hold, and what Finance should look at' })
  getCase(@Headers('x-tenant-id') tenantId: string, @Param('caseId', ParseUUIDPipe) caseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.GET_CASE, { tenantId, caseId });
  }

  @Patch('cases/:caseId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions(...MANAGE)
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'Change the type, notice date, last working day or reason of an open case' })
  updateCase(@Headers('x-tenant-id') tenantId: string, @Param('caseId', ParseUUIDPipe) caseId: string, @Body() dto: UpdateOffboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.UPDATE, { tenantId, caseId, dto });
  }

  @Post('cases/:caseId/cancel')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions(...MANAGE)
  @ApiParam({ name: 'caseId' })
  @ApiOperation({ summary: 'They are staying: close the case. Nothing about the employee changes' })
  cancelCase(@Headers('x-tenant-id') tenantId: string, @Param('caseId', ParseUUIDPipe) caseId: string, @Body() dto: CancelOffboardingDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.CANCEL, { tenantId, caseId, dto });
  }

  @Post('cases/:caseId/stages/:stage/clear')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions(...CLEAR)
  @ApiParam({ name: 'caseId' })
  @ApiParam({ name: 'stage', description: 'MANAGER | HR | IT | FINANCE, or the key of a step the department added (DEPT-1, DEPT-2 ...)' })
  @ApiOperation({ summary: 'Say this department has nothing outstanding. HR clears HR and the manager step, Finance clears Finance. IT comes from the asset clearance' })
  clearStage(
    @Headers('x-tenant-id') tenantId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('stage', ParseStagePipe) stage: string,
    @Body() dto: OffboardingNoteDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.CLEAR_STAGE, { tenantId, caseId, stage, dto });
  }

  @Post('cases/:caseId/stages/:stage/reopen')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions(...CLEAR)
  @ApiParam({ name: 'caseId' })
  @ApiParam({ name: 'stage', description: 'MANAGER | HR | IT | FINANCE, or the key of a step the department added (DEPT-1, DEPT-2 ...)' })
  @ApiOperation({ summary: 'Take a clearance back because something turned up' })
  reopenStage(
    @Headers('x-tenant-id') tenantId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('stage', ParseStagePipe) stage: string,
    @Body() dto: OffboardingNoteDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.OFFBOARDING.REOPEN_STAGE, { tenantId, caseId, stage, dto });
  }
}
