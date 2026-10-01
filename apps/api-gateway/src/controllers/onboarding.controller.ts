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
  UseGuards,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  GetNewHiresQueryDto,
  ExportNewHiresQueryDto,
  CreateNewHireDto,
  UpdateNewHireDto,
  GetOnboardingProgressQueryDto,
  GetOnboardingTasksQueryDto,
  GetUpcomingOnboardingTasksQueryDto,
  CreateOnboardingTaskDto,
  UpdateOnboardingTaskDto,
  SetOnboardingTaskStatusDto,
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
import { sendCsvExport } from '../utils/csv-export.helper';

/**
 * Admin-side Onboarding screen (organization portal).
 *
 * Covers the whole screen: the four KPI cards, the Onboarding Progress donut,
 * the Upcoming Tasks checklist panel, the New Hires table, Add New Hire, and
 * the per-hire checklist behind it.
 *
 * A new hire's Status is derived from their checklist on every read, so there
 * is deliberately no endpoint to set it. Ticking a task at
 * PATCH /onboarding/tasks/:taskId/status is what moves a hire between
 * Pending, In Progress and Completed — a second write path for the same fact
 * would let the Status column disagree with the checklist under it.
 *
 * Hires that arrive from recruitment are created by the candidate stage move
 * (PATCH /organization/recruitment/candidates/:id/stage to HIRED), which
 * opens the record and seeds the same default checklist. Add New Hire here is
 * for people hired outside the pipeline.
 */
@Controller('organization/onboarding')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.ONBOARDING)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class OnboardingController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // KPI cards + progress donut
  // ==========================================

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('stats')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Onboarding KPI cards (Total New Hires / Completed Onboarding / In Progress / Pending Tasks) with month-over-month growth. Completed and In Progress are derived from each hire checklist',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.GET_STATS, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('progress')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Onboarding Progress donut — overall completion measured across checklist items, plus the hire count per derived status for the legend',
  })
  getProgress(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetOnboardingProgressQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.GET_PROGRESS, {
      tenantId,
      query,
    });
  }

  // ==========================================
  // Upcoming Tasks panel + the checklist
  // NOTE: the static sub-routes are declared before ':taskId' so Express
  // doesn't match "upcoming" as a task id.
  // ==========================================

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('tasks/upcoming')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Upcoming Tasks panel — open checklist items due soonest first. Overdue items are always included regardless of the window, and each row is flagged when it has slipped',
  })
  getUpcomingTasks(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetUpcomingOnboardingTasksQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.ONBOARDING_TASK.GET_UPCOMING,
      { tenantId, query },
    );
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('tasks')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Checklist items — paginated and searchable, filterable by new hire, status and category',
  })
  getTasks(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetOnboardingTasksQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Post('tasks')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.CREATE)
  @RequirePermissions('onboarding.create', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Add a checklist item to a new hire, on top of the default checklist they were seeded with',
  })
  createTask(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateOnboardingTaskDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.CREATE, {
      tenantId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('tasks/:taskId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiParam({ name: 'taskId', description: 'Onboarding Task ID' })
  @ApiOperation({ summary: 'One checklist item with its hire and assignee' })
  getTask(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.GET_ONE, {
      tenantId,
      taskId,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Patch('tasks/:taskId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.EDIT)
  @RequirePermissions('onboarding.edit', 'onboarding.manage')
  @ApiParam({ name: 'taskId', description: 'Onboarding Task ID' })
  @ApiOperation({
    summary:
      'Edit a checklist item title, category, due date, assignee or position. Completion is not set here — use the status route',
  })
  updateTask(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateOnboardingTaskDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.UPDATE, {
      tenantId,
      taskId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Patch('tasks/:taskId/status')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.EDIT)
  @RequirePermissions('onboarding.edit', 'onboarding.manage')
  @ApiParam({ name: 'taskId', description: 'Onboarding Task ID' })
  @ApiOperation({
    summary:
      "Tick or untick a checklist item. This is what moves the hire's derived status and the progress donut; reopening clears the completion stamp",
  })
  setTaskStatus(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId') taskId: string,
    @Body() dto: SetOnboardingTaskStatusDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.SET_STATUS, {
      tenantId,
      taskId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Delete('tasks/:taskId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.DELETE)
  @RequirePermissions('onboarding.delete', 'onboarding.manage')
  @ApiParam({ name: 'taskId', description: 'Onboarding Task ID' })
  @ApiOperation({
    summary:
      "Remove a checklist item. This changes the hire's derived status, since the status is a function of the remaining items",
  })
  deleteTask(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ONBOARDING_TASK.DELETE, {
      tenantId,
      taskId,
    });
  }

  // ==========================================
  // New Hires table
  // ==========================================

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('new-hires/export')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.EXPORT)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({ summary: 'Export the filtered new hires as CSV' })
  async exportNewHires(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportNewHiresQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.NEW_HIRE.EXPORT,
      { tenantId, query },
      'new-hires',
      [
        { header: 'Employee Name', value: (row) => row.name },
        { header: 'Email', value: (row) => row.email },
        { header: 'Phone', value: (row) => row.phone },
        { header: 'Position', value: (row) => row.position },
        { header: 'Department', value: (row) => row.department?.name },
        { header: 'Designation', value: (row) => row.designation?.name },
        { header: 'Join Date', value: (row) => row.joiningDate },
        { header: 'Status', value: (row) => row.status },
        { header: 'Tasks Completed', value: (row) => row.tasks?.completed },
        { header: 'Tasks Total', value: (row) => row.tasks?.total },
        { header: 'Progress %', value: (row) => row.tasks?.progressPercentage },
        {
          header: 'Reporting Manager',
          value: (row) => row.reportingManager?.name,
        },
      ],
    );
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('new-hires')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiOperation({
    summary:
      'New Hires table — paginated and searchable, filterable by derived status, department, designation and joining date range. Each row carries its checklist tallies and progress',
  })
  getNewHires(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetNewHiresQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Post('new-hires')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.CREATE)
  @RequirePermissions('onboarding.create', 'onboarding.manage')
  @ApiOperation({
    summary:
      'Add New Hire. The default checklist is seeded relative to the joining date unless seedDefaultTasks is false. A hire is not an employee record — link one via employeeId once they start',
  })
  createNewHire(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateNewHireDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.CREATE, {
      tenantId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Get('new-hires/:newHireId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.VIEW)
  @RequirePermissions('onboarding.view', 'onboarding.manage')
  @ApiParam({ name: 'newHireId', description: 'New Hire ID' })
  @ApiOperation({
    summary: 'One new hire with their derived status and checklist progress',
  })
  getNewHire(
    @Headers('x-tenant-id') tenantId: string,
    @Param('newHireId') newHireId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.GET_ONE, {
      tenantId,
      newHireId,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Patch('new-hires/:newHireId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.EDIT)
  @RequirePermissions('onboarding.edit', 'onboarding.manage')
  @ApiParam({ name: 'newHireId', description: 'New Hire ID' })
  @ApiOperation({
    summary:
      'Edit a new hire. Status is absent by design — it follows the checklist. Editing the joining date does not move already-seeded task due dates',
  })
  updateNewHire(
    @Headers('x-tenant-id') tenantId: string,
    @Param('newHireId') newHireId: string,
    @Body() dto: UpdateNewHireDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.UPDATE, {
      tenantId,
      newHireId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_ONBOARDING)
  @Delete('new-hires/:newHireId')
  @RequireModule(HRMSModuleKey.ONBOARDING, ModuleAction.DELETE)
  @RequirePermissions('onboarding.delete', 'onboarding.manage')
  @ApiParam({ name: 'newHireId', description: 'New Hire ID' })
  @ApiOperation({
    summary: 'Delete a new hire and their whole checklist',
  })
  deleteNewHire(
    @Headers('x-tenant-id') tenantId: string,
    @Param('newHireId') newHireId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.NEW_HIRE.DELETE, {
      tenantId,
      newHireId,
    });
  }
}
