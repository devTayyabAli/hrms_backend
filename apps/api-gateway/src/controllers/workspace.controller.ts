import { Body, Controller, Delete, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  grantsPermission,
  CreateCalendarEventDto,
  CreateWorkspaceProjectDto,
  CreateWorkspaceTaskDto,
  ExportWorkspaceTasksQueryDto,
  GetCalendarQueryDto,
  GetMyTasksQueryDto,
  GetWorkspaceProjectsQueryDto,
  GetWorkspaceTasksQueryDto,
  UpdateCalendarEventDto,
  UpdateTaskStatusDto,
  UpdateWorkspaceProjectDto,
  UpdateWorkspaceTaskDto,
  WorkspaceTaskFiltersDto,
  GetCompanyDocumentsQueryDto,
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
import { sendCsvExport } from '../utils/csv-export.helper';

const titleCase = (value?: string | null) =>
  value ? value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ') : '';

/**
 * Workspace › Tasks, Projects and the Company Calendar, for Org Admin, HR and
 * any role granted `tasks.*`, `projects.*` or `calendar.*`.
 *
 * Tasks and Projects are the `projects` module ("Projects & Tasks"); the
 * calendar is `calendar`. Static sub-routes (`stats`, `export`, `options`)
 * are declared before `:id` routes so Express doesn't read them as ids.
 */
@Controller('organization/workspace')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_WORKSPACE)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class WorkspaceController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  // ==========================================
  // People picker
  // ==========================================

  @Get('people')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.create', 'tasks.edit', 'tasks.manage', 'projects.create', 'projects.edit', 'projects.manage')
  @ApiOperation({ summary: 'Current staff within the caller’s data scope — the assignee and project-lead picker' })
  getPeople(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_PEOPLE, { tenantId });
  }

  // ==========================================
  // Tasks
  // ==========================================

  @Get('tasks/stats')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage')
  @ApiOperation({ summary: 'Task KPI cards and tab counts (total / pending / in progress / completed / overdue) for the current filters' })
  getTaskStats(@Headers('x-tenant-id') tenantId: string, @Query() query: WorkspaceTaskFiltersDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_STATS, { tenantId, query });
  }

  @Get('tasks/export')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EXPORT)
  @RequirePermissions('tasks.export', 'tasks.manage')
  @ApiOperation({ summary: 'Export the filtered tasks as CSV' })
  exportTasks(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportWorkspaceTasksQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(res, this.tenantClient, MESSAGE_PATTERNS.WORKSPACE_TASK.EXPORT, { tenantId, query }, 'tasks', [
      { header: 'Task', value: (row) => row.title },
      { header: 'Project', value: (row) => row.project?.name },
      { header: 'Assignee', value: (row) => row.assignee?.name },
      { header: 'Department', value: (row) => row.assignee?.department?.name },
      { header: 'Due Date', value: (row) => row.dueDate },
      { header: 'Priority', value: (row) => titleCase(row.priority) },
      { header: 'Status', value: (row) => titleCase(row.status) },
      { header: 'Overdue', value: (row) => (row.overdue ? 'Yes' : 'No') },
      { header: 'Description', value: (row) => row.description },
    ]);
  }

  @Get('tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage')
  @ApiOperation({ summary: 'Team tasks: paginated, searchable, filterable by status, priority, project, assignee and overdue' })
  getTasks(@Headers('x-tenant-id') tenantId: string, @Query() query: GetWorkspaceTasksQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ALL, { tenantId, query });
  }

  @Get('tasks/:taskId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage')
  @ApiOperation({ summary: 'One task' })
  getTask(@Headers('x-tenant-id') tenantId: string, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ONE, { tenantId, taskId });
  }

  @Post('tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.CREATE)
  @RequirePermissions('tasks.create', 'tasks.manage')
  @ApiOperation({ summary: 'Create a task and notify the assignee' })
  createTask(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateWorkspaceTaskDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.CREATE, { tenantId, dto, actorUserId });
  }

  @Patch('tasks/:taskId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage')
  @ApiOperation({ summary: 'Edit a task; reassigning it notifies the new assignee' })
  updateTask(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpdateWorkspaceTaskDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.UPDATE, { tenantId, taskId, dto });
  }

  @Delete('tasks/:taskId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.DELETE)
  @RequirePermissions('tasks.delete', 'tasks.manage')
  @ApiOperation({ summary: 'Delete a task' })
  deleteTask(@Headers('x-tenant-id') tenantId: string, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE, { tenantId, taskId });
  }

  // ==========================================
  // Projects
  // ==========================================

  @Get('projects/options')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('projects.view', 'projects.manage', 'tasks.view', 'tasks.manage')
  @ApiOperation({ summary: 'Every project as { id, name, status } — the task form’s project picker' })
  getProjectOptions(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.GET_OPTIONS, { tenantId });
  }

  @Get('projects/export')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EXPORT)
  @RequirePermissions('projects.export', 'projects.manage')
  @ApiOperation({ summary: 'Export the filtered projects as CSV' })
  exportProjects(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetWorkspaceProjectsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(res, this.tenantClient, MESSAGE_PATTERNS.WORKSPACE_PROJECT.EXPORT, { tenantId, query }, 'projects', [
      { header: 'Project', value: (row) => row.name },
      { header: 'Client', value: (row) => row.client },
      { header: 'Lead', value: (row) => row.lead?.name },
      { header: 'Department', value: (row) => row.department?.name },
      { header: 'Status', value: (row) => titleCase(row.status) },
      { header: 'Progress %', value: (row) => row.progress },
      { header: 'Open Tasks', value: (row) => row.openTasks },
      { header: 'Overdue Tasks', value: (row) => row.overdueTasks },
      { header: 'Due Date', value: (row) => row.dueDate },
      { header: 'Next Milestone', value: (row) => row.milestone },
    ]);
  }

  @Get('projects')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('projects.view', 'projects.manage')
  @ApiOperation({ summary: 'Projects with lead, department, computed progress and task counts, plus status KPI counts' })
  getProjects(@Headers('x-tenant-id') tenantId: string, @Query() query: GetWorkspaceProjectsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.GET_ALL, { tenantId, query });
  }

  @Post('projects')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.CREATE)
  @RequirePermissions('projects.create', 'projects.manage')
  @ApiOperation({ summary: 'Create a project' })
  createProject(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateWorkspaceProjectDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.CREATE, { tenantId, dto, actorUserId });
  }

  @Patch('projects/:projectId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('projects.edit', 'projects.manage')
  @ApiOperation({ summary: 'Edit a project' })
  updateProject(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateWorkspaceProjectDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.UPDATE, { tenantId, projectId, dto });
  }

  @Delete('projects/:projectId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.DELETE)
  @RequirePermissions('projects.delete', 'projects.manage')
  @ApiOperation({ summary: 'Delete a project; its tasks are kept without a project' })
  deleteProject(@Headers('x-tenant-id') tenantId: string, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.DELETE, { tenantId, projectId });
  }

  // ==========================================
  // Company Calendar
  // ==========================================

  @Get('calendar')
  @RequireModule(HRMSModuleKey.CALENDAR, ModuleAction.VIEW)
  @RequirePermissions('calendar.view', 'calendar.manage')
  @ApiOperation({ summary: 'One month of the Company Calendar: events, holidays, birthdays and work anniversaries' })
  getCalendar(@Headers('x-tenant-id') tenantId: string, @Query() query: GetCalendarQueryDto, @CurrentUser() user: any) {
    const permissions: string[] = user?.permissions ?? [];
    const canEdit =
      Boolean(user?.isFullAccess) ||
      permissions.includes('*') ||
      ['calendar.edit', 'calendar.delete', 'calendar.manage'].some((p) => grantsPermission(permissions, p));
    return this.tenantClient.send(MESSAGE_PATTERNS.CALENDAR.GET_MONTH, { tenantId, query, canEdit });
  }

  @Post('calendar/events')
  @RequireModule(HRMSModuleKey.CALENDAR, ModuleAction.CREATE)
  @RequirePermissions('calendar.create', 'calendar.manage')
  @ApiOperation({ summary: 'Add an event or company holiday' })
  createEvent(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateCalendarEventDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CALENDAR.CREATE_EVENT, { tenantId, dto, actorUserId });
  }

  @Patch('calendar/events/:eventId')
  @RequireModule(HRMSModuleKey.CALENDAR, ModuleAction.EDIT)
  @RequirePermissions('calendar.edit', 'calendar.manage')
  @ApiOperation({ summary: 'Edit an event or holiday' })
  updateEvent(
    @Headers('x-tenant-id') tenantId: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: UpdateCalendarEventDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CALENDAR.UPDATE_EVENT, { tenantId, eventId, dto });
  }

  @Delete('calendar/events/:eventId')
  @RequireModule(HRMSModuleKey.CALENDAR, ModuleAction.DELETE)
  @RequirePermissions('calendar.delete', 'calendar.manage')
  @ApiOperation({ summary: 'Delete an event or holiday' })
  deleteEvent(@Headers('x-tenant-id') tenantId: string, @Param('eventId', ParseUUIDPipe) eventId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CALENDAR.DELETE_EVENT, { tenantId, eventId });
  }
}

/**
 * Employee self-service: "My Tasks" and a read-only Company Calendar. Needs
 * no permission beyond being signed in, but the organization still has to
 * have the module.
 */
@Controller('organization/me')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class WorkspaceSelfController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get('tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'My Tasks — tasks assigned to me, open work first, with counts' })
  getMyTasks(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyTasksQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_MINE, { tenantId, userId, email, query });
  }

  @Patch('tasks/:taskId/status')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Move one of my own tasks to Pending, In Progress or Completed' })
  updateMyTaskStatus(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.UPDATE_MY_STATUS, {
      tenantId,
      userId,
      email,
      taskId,
      status: dto.status,
    });
  }

  @Get('calendar')
  @RequireModule(HRMSModuleKey.CALENDAR, ModuleAction.VIEW)
  @ApiOperation({ summary: 'The Company Calendar for one month, read-only' })
  getMyCalendar(@Headers('x-tenant-id') tenantId: string, @Query() query: GetCalendarQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CALENDAR.GET_MY_MONTH, { tenantId, query });
  }

  @Get('company-documents')
  @RequireModule(HRMSModuleKey.DOCUMENTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Published company documents (handbook, policies…), read-only' })
  getPublishedDocuments(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetCompanyDocumentsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.COMPANY_DOCUMENT.GET_PUBLISHED, { tenantId, userId, email, query });
  }
}
