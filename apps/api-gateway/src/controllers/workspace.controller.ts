import { BadRequestException, Body, Controller, Delete, Get, Headers, Inject, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  grantsPermission,
  CreateCalendarEventDto,
  CreateWorkspaceProjectDto,
  CreateWorkspaceTaskDto,
  CreateWorkspaceTaskCommentDto,
  CreateWorkspaceChecklistItemDto,
  UpdateWorkspaceChecklistItemDto,
  CreateWorkspaceTaskAttachmentDto,
  DecideWorkspaceTaskReviewDto,
  UpdateWorkspaceSettingsDto,
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
  AllowProjectOwner,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { resolveOwnFile } from '../utils/chat-attachment';
import { sendCsvExport } from '../utils/csv-export.helper';
import { sendFileResponse } from '../utils/file-response.helper';

const activityLogger = new Logger('WorkspaceActivity');

const canModerateTask = (user?: { permissions?: string[]; isFullAccess?: boolean }) => {
  const permissions: string[] = user?.permissions ?? [];
  return (
    user?.isFullAccess === true ||
    permissions.includes('*') ||
    ['tasks.manage', 'projects.manage'].some((permission) => grantsPermission(permissions, permission))
  );
};

async function ownTaskFile(authClient: ClientProxy, tenantId: string, userId: string, fileId: string) {
  const file = await resolveOwnFile(authClient, tenantId, userId, fileId);
  if (file.category !== 'task') {
    throw new BadRequestException('Upload the file as a task attachment first.');
  }
  return file;
}

async function streamTaskFile(authClient: ClientProxy, res: Response, tenantId: string, fileId: string) {
  const result: any = await firstValueFrom(
    authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, { fileId, userTenantId: tenantId }),
  );
  if (result && result.buffer) return sendFileResponse(res, result, true);
  return res.status(404).json({ message: 'File stream unavailable.' });
}

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
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  // ==========================================
  // People picker
  // ==========================================

  @Get('dashboard')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage', 'projects.view', 'projects.manage')
  @ApiOperation({ summary: 'Workspace home for a manager, department head, or the whole organization' })
  getWorkspaceDashboard(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_DASHBOARD, { tenantId });
  }

  @Get('settings')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.create', 'tasks.edit', 'tasks.manage', 'projects.view', 'projects.manage', 'settings.view', 'settings.manage')
  @ApiOperation({ summary: 'Whether completing a task can wait for review. Off unless an admin turns it on.' })
  getWorkspaceSettings(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_SETTINGS, { tenantId });
  }

  @Patch('settings')
  @RequireModule(HRMSModuleKey.SETTINGS, ModuleAction.EDIT)
  @RequirePermissions('settings.edit', 'settings.manage')
  @ApiOperation({ summary: 'Turn task review on or off. Off completes tasks directly.' })
  updateWorkspaceSettings(@Headers('x-tenant-id') tenantId: string, @Body() dto: UpdateWorkspaceSettingsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.UPDATE_SETTINGS, { tenantId, dto });
  }

  @Get('people')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.create', 'tasks.edit', 'tasks.manage', 'projects.create', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
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
      { header: 'Assignee', value: (row) => (row.assignees?.length ? row.assignees.map((person: { name: string }) => person.name).join(', ') : row.assignee?.name) },
      { header: 'Department', value: (row) => row.assignee?.department?.name },
      { header: 'Due Date', value: (row) => row.dueDate },
      { header: 'Date Exception', value: (row) => (row.dueDateException ? 'Yes' : 'No') },
      { header: 'Priority', value: (row) => titleCase(row.priority) },
      { header: 'Status', value: (row) => titleCase(row.status) },
      { header: 'Overdue', value: (row) => (row.overdue ? 'Yes' : 'No') },
      { header: 'Needs Reassignment', value: (row) => (row.needsReassignment ? 'Yes' : 'No') },
      { header: 'Description', value: (row) => row.description },
    ]);
  }

  @Get('tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Team tasks: paginated, searchable, filterable by status, priority, project, assignee and overdue' })
  getTasks(@Headers('x-tenant-id') tenantId: string, @Query() query: GetWorkspaceTasksQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ALL, { tenantId, query });
  }

  @Get('tasks/:taskId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'One task' })
  getTask(@Headers('x-tenant-id') tenantId: string, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ONE, { tenantId, taskId });
  }

  @Post('tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.CREATE)
  @RequirePermissions('tasks.create', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Create a task and notify the assignee' })
  createTask(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateWorkspaceTaskDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.CREATE, { tenantId, dto, actorUserId });
  }

  @Post('tasks/:taskId/review')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Approve or return a task that is waiting for review. An assignee cannot review their own task.' })
  decideTaskReview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: DecideWorkspaceTaskReviewDto,
    @CurrentUser() user: { permissions?: string[]; isFullAccess?: boolean },
  ) {
    const permissions: string[] = user?.permissions ?? [];
    const canManage =
      user?.isFullAccess === true ||
      permissions.includes('*') ||
      ['tasks.manage', 'projects.manage'].some((permission) => grantsPermission(permissions, permission));
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DECIDE_REVIEW, {
      tenantId,
      taskId,
      decision: dto.decision,
      canManage,
    });
  }

  @Post('tasks/:taskId/comments')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Add a comment. Completing the task keeps it.' })
  addTaskComment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateWorkspaceTaskCommentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.ADD_COMMENT, {
      tenantId,
      taskId,
      body: dto.body,
      userId,
      email,
      scope: 'manage',
    });
  }

  @Delete('tasks/:taskId/comments/:commentId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Delete your own comment, or any comment if you manage tasks' })
  deleteTaskComment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: { permissions?: string[]; isFullAccess?: boolean },
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE_COMMENT, {
      tenantId,
      taskId,
      commentId,
      userId,
      canModerate: canModerateTask(user),
      scope: 'manage',
    });
  }

  @Post('tasks/:taskId/checklist')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Add an optional checklist line' })
  addChecklistItem(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateWorkspaceChecklistItemDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.ADD_CHECKLIST, { tenantId, taskId, label: dto.label });
  }

  @Patch('tasks/:taskId/checklist/:itemId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Rename a checklist line or mark it done' })
  updateChecklistItem(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateWorkspaceChecklistItemDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.UPDATE_CHECKLIST, {
      tenantId,
      taskId,
      itemId,
      label: dto.label,
      done: dto.done,
      scope: 'manage',
    });
  }

  @Delete('tasks/:taskId/checklist/:itemId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Remove a checklist line' })
  deleteChecklistItem(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE_CHECKLIST, { tenantId, taskId, itemId });
  }

  @Post('tasks/:taskId/attachments')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Attach a file already uploaded with category "task"' })
  async addTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateWorkspaceTaskAttachmentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
  ) {
    const file = await ownTaskFile(this.authClient, tenantId, userId, dto.fileId);
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.ADD_ATTACHMENT, {
      tenantId,
      taskId,
      fileId: file.fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      userId,
      email,
      scope: 'manage',
    });
  }

  @Delete('tasks/:taskId/attachments/:attachmentId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Remove an attachment you uploaded, or any attachment if you manage tasks' })
  async deleteTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: { permissions?: string[]; isFullAccess?: boolean },
  ) {
    const removed: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE_ATTACHMENT, {
        tenantId,
        taskId,
        attachmentId,
        userId,
        canModerate: canModerateTask(user),
        scope: 'manage',
      }),
    );
    if (removed?.fileId) {
      try {
        await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, { fileId: removed.fileId, userTenantId: tenantId }));
      } catch (error: any) {
        activityLogger.warn(`Stored file ${removed.fileId} could not be deleted: ${error?.message ?? error}`);
      }
    }
    return removed?.task ?? removed;
  }

  @Get('tasks/:taskId/attachments/:attachmentId/download')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('tasks.view', 'tasks.manage', 'projects.view', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Download a task attachment when you can see the task' })
  async downloadTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Res() res: Response,
  ) {
    const meta: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ATTACHMENT, {
        tenantId,
        taskId,
        attachmentId,
        userId,
        email,
        scope: 'manage',
      }),
    );
    return streamTaskFile(this.authClient, res, tenantId, meta.fileId);
  }

  @Patch('tasks/:taskId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.EDIT)
  @RequirePermissions('tasks.edit', 'tasks.manage')
  @AllowProjectOwner()
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
  @ApiOperation({ summary: 'Every project as { id, name, status, startDate, dueDate } — the task form’s project picker' })
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
      { header: 'Team', value: (row) => (row.members ?? []).map((member: { name: string }) => member.name).join(', ') },
      { header: 'Department', value: (row) => row.department?.name },
      { header: 'Status', value: (row) => titleCase(row.status) },
      { header: 'Priority', value: (row) => titleCase(row.priority) },
      { header: 'Progress %', value: (row) => row.progress },
      { header: 'Open Tasks', value: (row) => row.openTasks },
      { header: 'Overdue Tasks', value: (row) => row.overdueTasks },
      { header: 'Start Date', value: (row) => row.startDate },
      { header: 'Expected End', value: (row) => row.dueDate },
      { header: 'Location', value: (row) => row.location },
      { header: 'Tags', value: (row) => (row.tags ?? []).join(', ') },
      { header: 'Next Milestone', value: (row) => row.milestone },
      { header: 'Confidential', value: (row) => (row.confidential ? 'Yes' : 'No') },
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
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Edit a project' })
  updateProject(
    @Headers('x-tenant-id') tenantId: string,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateWorkspaceProjectDto,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser() user: { permissions?: string[]; isFullAccess?: boolean },
  ) {
    const permissions: string[] = user?.permissions ?? [];
    const canReopen =
      user?.isFullAccess === true ||
      permissions.includes('*') ||
      grantsPermission(permissions, 'projects.reopen');
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.UPDATE, { tenantId, projectId, dto, actorUserId, canReopen });
  }

  @Get('projects/:projectId/open-tasks')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @RequirePermissions('projects.view', 'projects.edit', 'projects.manage')
  @AllowProjectOwner()
  @ApiOperation({ summary: 'Incomplete and blocked tasks to review before a project is closed' })
  getProjectOpenTasks(@Headers('x-tenant-id') tenantId: string, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_PROJECT.GET_OPEN_TASKS, { tenantId, projectId });
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
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  @Get('workspace')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'My projects, deadlines, overdue work and recently completed tasks' })
  getMyWorkspace(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_MY_DASHBOARD, { tenantId, userId, email });
  }

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

  @Post('tasks/:taskId/comments')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Add a comment on a task assigned to me' })
  addMyTaskComment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateWorkspaceTaskCommentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.ADD_COMMENT, {
      tenantId,
      taskId,
      body: dto.body,
      userId,
      email,
      scope: 'mine',
    });
  }

  @Delete('tasks/:taskId/comments/:commentId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Delete my own comment on a task assigned to me' })
  deleteMyTaskComment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE_COMMENT, {
      tenantId,
      taskId,
      commentId,
      userId,
      canModerate: false,
      scope: 'mine',
    });
  }

  @Patch('tasks/:taskId/checklist/:itemId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Check or uncheck a line on a task assigned to me' })
  updateMyChecklistItem(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateWorkspaceChecklistItemDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.UPDATE_CHECKLIST, {
      tenantId,
      taskId,
      itemId,
      done: dto.done,
      userId,
      email,
      scope: 'mine',
    });
  }

  @Post('tasks/:taskId/attachments')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Attach a file I uploaded to a task assigned to me' })
  async addMyTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateWorkspaceTaskAttachmentDto,
  ) {
    const file = await ownTaskFile(this.authClient, tenantId, userId, dto.fileId);
    return this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.ADD_ATTACHMENT, {
      tenantId,
      taskId,
      fileId: file.fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      userId,
      email,
      scope: 'mine',
    });
  }

  @Delete('tasks/:taskId/attachments/:attachmentId')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Remove a file I uploaded on a task assigned to me' })
  async deleteMyTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    const removed: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.DELETE_ATTACHMENT, {
        tenantId,
        taskId,
        attachmentId,
        userId,
        canModerate: false,
        scope: 'mine',
      }),
    );
    if (removed?.fileId) {
      try {
        await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, { fileId: removed.fileId, userTenantId: tenantId }));
      } catch (error: any) {
        activityLogger.warn(`Stored file ${removed.fileId} could not be deleted: ${error?.message ?? error}`);
      }
    }
    return removed?.task ?? removed;
  }

  @Get('tasks/:taskId/attachments/:attachmentId/download')
  @RequireModule(HRMSModuleKey.PROJECTS, ModuleAction.VIEW)
  @ApiOperation({ summary: 'Download a file on a task assigned to me' })
  async downloadMyTaskAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res() res: Response,
  ) {
    const meta: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.WORKSPACE_TASK.GET_ATTACHMENT, {
        tenantId,
        taskId,
        attachmentId,
        userId,
        email,
        scope: 'mine',
      }),
    );
    return streamTaskFile(this.authClient, res, tenantId, meta.fileId);
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
