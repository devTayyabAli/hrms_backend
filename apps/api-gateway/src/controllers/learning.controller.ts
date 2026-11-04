import {
  BadRequestException,
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
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  AddTrainingMaterialDto,
  AssignTrainingDto,
  CancelTrainingAssignmentDto,
  CreateTrainingCourseDto,
  GetTrainingAssignmentsQueryDto,
  GetTrainingCoursesQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  SetTrainingMaterialOrderDto,
  TRAINING_FILE_CATEGORY,
  TrainingMaterialKind,
  ApproveTrainingRecommendationDto,
  CreateTrainingRecommendationDto,
  DismissTrainingRecommendationDto,
  GetLearningReportQueryDto,
  GetMyLearningHistoryQueryDto,
  LearningReportGroup,
  type CsvColumn,
  GetTrainingRecommendationsQueryDto,
  UpdateLearningSettingsDto,
  UpdateTrainingAssignmentDto,
  UpdateTrainingCourseDto,
  UpdateTrainingMaterialDto,
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
import { resolveOwnFile } from '../utils/chat-attachment';
import { sendFileResponse } from '../utils/file-response.helper';

type AssignmentExportRow = {
  employee: { name: string | null; employeeCode: string | null };
  department: string | null;
  designation: string | null;
  courseTitle: string;
  mandatory: boolean;
  status: string;
  assignedAt: Date | string;
  dueDate: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  completedLate: boolean;
  overdueDays: number;
  source: string;
  assignedBy: string | null;
};

const day = (value: Date | string | null) => (value ? new Date(value).toISOString().slice(0, 10) : '');
const STATUS_LABEL: Record<string, string> = {
  NOT_STARTED: 'Not started',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  OVERDUE: 'Overdue',
  CANCELLED: 'Cancelled',
};

const ASSIGNMENT_CSV_COLUMNS: CsvColumn<AssignmentExportRow>[] = [
  { header: 'Employee', value: (row) => row.employee?.name ?? '' },
  { header: 'Employee Code', value: (row) => row.employee?.employeeCode ?? '' },
  { header: 'Department', value: (row) => row.department ?? '' },
  { header: 'Designation', value: (row) => row.designation ?? '' },
  { header: 'Course', value: (row) => row.courseTitle },
  { header: 'Mandatory', value: (row) => (row.mandatory ? 'Yes' : 'No') },
  { header: 'Status', value: (row) => STATUS_LABEL[row.status] ?? row.status },
  { header: 'Assigned On', value: (row) => day(row.assignedAt) },
  { header: 'Due Date', value: (row) => row.dueDate ?? '' },
  { header: 'Started On', value: (row) => day(row.startedAt) },
  { header: 'Completed On', value: (row) => day(row.completedAt) },
  { header: 'Completed Late', value: (row) => (row.status === 'COMPLETED' ? (row.completedLate ? 'Yes' : 'No') : '') },
  { header: 'Days Overdue', value: (row) => (row.overdueDays > 0 ? row.overdueDays : '') },
  { header: 'Assigned Via', value: (row) => row.source },
  { header: 'Assigned By', value: (row) => row.assignedBy ?? '' },
];

/**
 * Learning (organization portal): the courses an organization offers and the
 * materials in them — creating, editing, publishing and archiving courses, and
 * attaching PDFs, documents, video links and other resources.
 *
 * Files are uploaded with `POST /files/upload` (category "training") first,
 * then attached to a course by `fileId`.
 */
@Controller('organization/learning')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_LEARNING)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.LEARNING)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class LearningController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  /** Who is acting, for the audit log. */
  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  // Static routes are declared before the `:courseId` ones so they are never read as an id.

  @Get('courses')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Courses: search, filter by status / category / mandatory, sort, page, with how many are in each state' })
  getCourses(@Headers('x-tenant-id') tenantId: string, @Query() query: GetTrainingCoursesQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.GET_ALL, { tenantId, query });
  }

  @Get('courses/categories')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Categories in use, with how many courses each has (for the filter)' })
  getCategories(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.GET_CATEGORIES, { tenantId });
  }

  @Post('courses')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.CREATE)
  @RequirePermissions('learning.create', 'learning.manage')
  @ApiOperation({ summary: 'Create a course. It starts as a draft' })
  createCourse(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateTrainingCourseDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.CREATE, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get('courses/:courseId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'One course with its materials' })
  getCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.GET_ONE, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Patch('courses/:courseId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Edit a course. An archived course has to be restored first' })
  updateCourse(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: UpdateTrainingCourseDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.UPDATE, { ...this.actor(tenantId, userId, email), courseId, dto });
  }

  @Delete('courses/:courseId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.DELETE)
  @RequirePermissions('learning.delete', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Delete a draft course. A published course is archived instead' })
  deleteCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.DELETE, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Post('courses/:courseId/publish')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Publish a draft course (it needs at least one material)' })
  publishCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.PUBLISH, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Post('courses/:courseId/archive')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Archive a published course. Its history is kept' })
  archiveCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.ARCHIVE, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Post('courses/:courseId/unarchive')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Restore an archived course (it is published again)' })
  unarchiveCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.UNARCHIVE, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Post('courses/:courseId/duplicate')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.CREATE)
  @RequirePermissions('learning.create', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Copy a course, with its materials, as a new draft titled "<title> Copy"' })
  duplicateCourse(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.DUPLICATE, { ...this.actor(tenantId, userId, email), courseId });
  }

  @Post('courses/:courseId/materials')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Add a material: a file (fileId from POST /files/upload, category "training"), a video link or another link' })
  async addMaterial(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: AddTrainingMaterialDto,
  ) {
    let file: { fileId: string; fileName: string; mimeType?: string; sizeBytes: number } | undefined;
    if (dto.kind === TrainingMaterialKind.FILE && dto.fileId) {
      // The file store only checks the file is the organization's: it has to be yours, and meant for training.
      const found = await resolveOwnFile(this.authClient, tenantId, userId, dto.fileId);
      if (found.category !== TRAINING_FILE_CATEGORY) {
        throw new BadRequestException(`Upload the file with category "${TRAINING_FILE_CATEGORY}" first.`);
      }
      file = { fileId: found.fileId, fileName: found.fileName, mimeType: found.mimeType, sizeBytes: found.sizeBytes };
    }
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.ADD_MATERIAL, { ...this.actor(tenantId, userId, email), courseId, dto, file });
  }

  @Put('courses/:courseId/materials/order')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiOperation({ summary: 'Set the order of the materials: list every material id, once each, in the order to show' })
  setMaterialOrder(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() dto: SetTrainingMaterialOrderDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.SET_MATERIAL_ORDER, { ...this.actor(tenantId, userId, email), courseId, dto });
  }

  @Patch('courses/:courseId/materials/:materialId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiParam({ name: 'materialId' })
  @ApiOperation({ summary: 'Edit a material\'s title, address (links only) or whether it is required' })
  updateMaterial(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Body() dto: UpdateTrainingMaterialDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.UPDATE_MATERIAL, { ...this.actor(tenantId, userId, email), courseId, materialId, dto });
  }

  @Delete('courses/:courseId/materials/:materialId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiParam({ name: 'materialId' })
  @ApiOperation({ summary: 'Remove a material. A published course keeps at least one' })
  deleteMaterial(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.DELETE_MATERIAL, { ...this.actor(tenantId, userId, email), courseId, materialId });
  }

  @Get('courses/:courseId/materials/:materialId/download')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiParam({ name: 'courseId' })
  @ApiParam({ name: 'materialId' })
  @ApiOperation({ summary: 'Preview or download a file material. A link has nothing to download' })
  async downloadMaterial(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res() res: Response,
  ) {
    const material: { fileId: string } = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_COURSE.GET_MATERIAL_FILE, { ...this.actor(tenantId, userId, email), courseId, materialId }),
    );
    const file: any = await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, { fileId: material.fileId, userTenantId: tenantId }));
    if (file && file.buffer) return sendFileResponse(res, file, true);
    return res.status(404).json({ message: 'File stream unavailable.' });
  }

  // ==========================================
  // Assigning
  // ==========================================

  @Get('dashboard')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Dashboard numbers: courses, assignments by state, completion rate, mandatory compliance, busiest courses' })
  getDashboard(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_DASHBOARD, { tenantId });
  }

  @Get('reports/courses')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Results per course: assigned, completed, overdue, completion rate, average days to complete' })
  getCourseReport(@Headers('x-tenant-id') tenantId: string, @Query() query: GetLearningReportQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_REPORT, { tenantId, group: LearningReportGroup.COURSE, query });
  }

  @Get('reports/departments')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Results per department, as it was when each course was assigned' })
  getDepartmentReport(@Headers('x-tenant-id') tenantId: string, @Query() query: GetLearningReportQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_REPORT, { tenantId, group: LearningReportGroup.DEPARTMENT, query });
  }

  @Get('assignments/export')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.export', 'learning.manage')
  @ApiOperation({ summary: 'Export the filtered assignments as CSV (same filters as the list; up to 10,000 rows)' })
  async exportAssignments(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetTrainingAssignmentsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<AssignmentExportRow>(res, this.tenantClient, MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.EXPORT, { tenantId, query }, 'learning-assignments', ASSIGNMENT_CSV_COLUMNS);
  }

  @Get('alerts')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Bell counts: overdue, mandatory overdue and due soon among the people you can reach' })
  getAlerts(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_ALERTS, { tenantId });
  }

  @Get('employees/:employeeId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiParam({ name: 'employeeId' })
  @ApiOperation({ summary: "One employee's learning record for their profile: current, completed and withdrawn courses, with counts" })
  getEmployeeLearning(
    @Headers('x-tenant-id') tenantId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: GetMyLearningHistoryQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_FOR_EMPLOYEE, { tenantId, employeeId, query });
  }

  @Post('recommendations')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.assign', 'learning.manage', 'performance.edit', 'performance.manage')
  @ApiOperation({ summary: 'Suggest a published course for someone you can reach, usually from a performance review. HR decides' })
  recommend(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateTrainingRecommendationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_RECOMMENDATION.CREATE, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get('recommendations')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Recommended courses for the people you can reach, pending by default' })
  getRecommendations(@Headers('x-tenant-id') tenantId: string, @Query() query: GetTrainingRecommendationsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_RECOMMENDATION.GET_ALL, { tenantId, query });
  }

  @Post('recommendations/:recommendationId/approve')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.assign', 'learning.manage')
  @ApiParam({ name: 'recommendationId' })
  @ApiOperation({ summary: 'Assign the recommended course: an ordinary assignment' })
  approveRecommendation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('recommendationId', ParseUUIDPipe) recommendationId: string,
    @Body() dto: ApproveTrainingRecommendationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_RECOMMENDATION.APPROVE, { ...this.actor(tenantId, userId, email), recommendationId, dto });
  }

  @Post('recommendations/:recommendationId/dismiss')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.assign', 'learning.manage')
  @ApiParam({ name: 'recommendationId' })
  @ApiOperation({ summary: 'Close a recommendation without assigning it' })
  dismissRecommendation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('recommendationId', ParseUUIDPipe) recommendationId: string,
    @Body() dto: DismissTrainingRecommendationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_RECOMMENDATION.DISMISS, { ...this.actor(tenantId, userId, email), recommendationId, dto });
  }

  @Get('settings')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Learning notification settings' })
  getSettings(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_SETTINGS, { tenantId });
  }

  @Patch('settings')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.edit', 'learning.manage')
  @ApiOperation({ summary: 'Change which Learning notifications go out and how many days before a due date the reminders are sent' })
  updateSettings(@Headers('x-tenant-id') tenantId: string, @Body() dto: UpdateLearningSettingsDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.UPDATE_SETTINGS, { tenantId, dto });
  }

  @Post('assignments')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.assign', 'learning.manage')
  @ApiOperation({
    summary:
      'Assign a published course to employees, to everyone in departments, or to everyone with designations. People outside what you can reach, or who already have it open, are skipped and counted',
  })
  assign(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: AssignTrainingDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.ASSIGN, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get('assignments')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiOperation({ summary: 'Assignments of the people you can reach: filter, search, sort, page, with a count per status' })
  getAssignments(@Headers('x-tenant-id') tenantId: string, @Query() query: GetTrainingAssignmentsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_ALL, { tenantId, query });
  }

  @Get('assignments/:assignmentId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
  @RequirePermissions('learning.view', 'learning.manage')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'One assignment with which materials the person has opened' })
  getAssignment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.GET_ONE, { ...this.actor(tenantId, userId, email), assignmentId });
  }

  @Patch('assignments/:assignmentId')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.assign', 'learning.manage')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Move the due date, or make an open assignment mandatory or optional' })
  updateAssignment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateTrainingAssignmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.UPDATE, { ...this.actor(tenantId, userId, email), assignmentId, dto });
  }

  @Post('assignments/:assignmentId/cancel')
  @RequireModule(HRMSModuleKey.LEARNING, ModuleAction.EDIT)
  @RequirePermissions('learning.assign', 'learning.manage')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Withdraw a course that has not been finished. A completed course stays on record' })
  cancelAssignment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: CancelTrainingAssignmentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_ASSIGNMENT.CANCEL, { ...this.actor(tenantId, userId, email), assignmentId, dto });
  }
}
