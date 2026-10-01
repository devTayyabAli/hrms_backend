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
  GetJobOpeningsQueryDto,
  ExportJobOpeningsQueryDto,
  CreateJobOpeningDto,
  UpdateJobOpeningDto,
  UpdateJobOpeningStatusDto,
  GetCandidatesQueryDto,
  ExportCandidatesQueryDto,
  GetCandidatePipelineQueryDto,
  CreateCandidateDto,
  UpdateCandidateDto,
  MoveCandidateStageDto,
  GetInterviewsQueryDto,
  GetUpcomingInterviewsQueryDto,
  ScheduleInterviewDto,
  UpdateInterviewDto,
  RescheduleInterviewDto,
  SubmitInterviewFeedbackDto,
  CancelInterviewDto,
  GetApplicationSourcesQueryDto,
  GetHiringGoalQueryDto,
  GetRecruitmentActivityQueryDto,
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
 * Admin-side Recruitment screen (organization portal).
 *
 * Covers the whole screen: the five KPI cards, the Job Openings table, the
 * Application Sources donut, the Recruitment Pipeline funnel, the Top Hiring
 * Goal widget, the Candidate Pipeline board, Upcoming Interviews and Recent
 * Activities — plus Create Job Opening and the candidate/interview actions
 * behind them.
 *
 * Departments and designations are deliberately absent here. A requisition
 * points at the tenant's own department and designation rows, already owned
 * by the Setup Wizard at /organization/departments — this screen only reads
 * them, so there is one place validating the org structure rather than two
 * free to drift apart.
 *
 * Every write is an administrative action, attributed to the acting admin via
 * `actorUserId`, which is what the Recent Activities feed shows. Candidate
 * self-service application is intentionally not here.
 */
@Controller('organization/recruitment')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@RequireModule(HRMSModuleKey.RECRUITMENT)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class RecruitmentController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  // ==========================================
  // KPI cards, charts and the activity feed
  // ==========================================

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('stats')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Recruitment KPI cards (Total Open Positions / Total Applications / Shortlisted Candidates / Interviews Scheduled / Hired) with month-over-month growth',
  })
  getStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.RECRUITMENT.GET_STATS, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('funnel')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Recruitment Pipeline funnel — per stage, how many candidates ever reached it, how many sit there now, and both conversion rates. Counts who reached a stage, so a rejection never shrinks the upper funnel',
  })
  getFunnel(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.RECRUITMENT.GET_FUNNEL, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('application-sources')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Application Sources donut — application counts and percentages per channel. Every channel is returned, including zeroes, so the legend stays stable',
  })
  getApplicationSources(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetApplicationSourcesQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.RECRUITMENT.GET_APPLICATION_SOURCES,
      { tenantId, query },
    );
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('hiring-goal')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Top Hiring Goal widget — hires made this month (or quarter) against the open seat count',
  })
  getHiringGoal(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetHiringGoalQueryDto,
  ) {
    return this.tenantClient.send(
      MESSAGE_PATTERNS.RECRUITMENT.GET_HIRING_GOAL,
      { tenantId, query },
    );
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('activity')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Recent Activities feed — applications, stage moves, interview events and offers, newest first with a pre-formatted "2 hours ago" label',
  })
  getActivity(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetRecruitmentActivityQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.RECRUITMENT.GET_ACTIVITY, {
      tenantId,
      query,
    });
  }

  // ==========================================
  // Job Openings
  // NOTE: the static sub-routes ('export') are declared before
  // ':jobOpeningId' so Express doesn't match them as a requisition id.
  // ==========================================

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('job-openings/export')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EXPORT)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({ summary: 'Export the filtered job openings as CSV' })
  async exportJobOpenings(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportJobOpeningsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.JOB_OPENING.EXPORT,
      { tenantId, query },
      'job-openings',
      [
        { header: 'Requisition', value: (row) => row.requisitionCode },
        { header: 'Position', value: (row) => row.title },
        { header: 'Department', value: (row) => row.department?.name },
        { header: 'Designation', value: (row) => row.designation?.name },
        { header: 'Employment Type', value: (row) => row.employmentType },
        { header: 'Location', value: (row) => row.location },
        { header: 'Openings', value: (row) => row.openings },
        { header: 'Applications', value: (row) => row.applicationsCount },
        { header: 'Status', value: (row) => row.status },
        { header: 'Posted On', value: (row) => row.postedOn },
        { header: 'Closing Date', value: (row) => row.closingDate },
        { header: 'Hiring Manager', value: (row) => row.hiringManager?.name },
      ],
    );
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('job-openings')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Job Openings table — paginated and searchable, filterable by status, department and employment type. Each row carries a live application count',
  })
  getJobOpenings(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetJobOpeningsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Post('job-openings')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.CREATE)
  @RequirePermissions('recruitment.create', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Create Job Opening. The requisition code is generated; Posted On defaults to today',
  })
  createJobOpening(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateJobOpeningDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.CREATE, {
      tenantId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('job-openings/:jobOpeningId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiParam({ name: 'jobOpeningId', description: 'Job Opening ID' })
  @ApiOperation({ summary: 'One job opening with its live application count' })
  getJobOpening(
    @Headers('x-tenant-id') tenantId: string,
    @Param('jobOpeningId') jobOpeningId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.GET_ONE, {
      tenantId,
      jobOpeningId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('job-openings/:jobOpeningId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'jobOpeningId', description: 'Job Opening ID' })
  @ApiOperation({
    summary:
      'Edit a job opening. Status is not editable here — use the status route so the change is recorded on the activity feed',
  })
  updateJobOpening(
    @Headers('x-tenant-id') tenantId: string,
    @Param('jobOpeningId') jobOpeningId: string,
    @Body() dto: UpdateJobOpeningDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.UPDATE, {
      tenantId,
      jobOpeningId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('job-openings/:jobOpeningId/status')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'jobOpeningId', description: 'Job Opening ID' })
  @ApiOperation({
    summary:
      'Open, pause (ON_HOLD) or close a requisition. Closing is how a posting is taken down — only ACTIVE requisitions count toward Total Open Positions',
  })
  updateJobOpeningStatus(
    @Headers('x-tenant-id') tenantId: string,
    @Param('jobOpeningId') jobOpeningId: string,
    @Body() dto: UpdateJobOpeningStatusDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.UPDATE_STATUS, {
      tenantId,
      jobOpeningId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Delete('job-openings/:jobOpeningId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.DELETE)
  @RequirePermissions('recruitment.delete', 'recruitment.manage')
  @ApiParam({ name: 'jobOpeningId', description: 'Job Opening ID' })
  @ApiOperation({
    summary:
      'Delete a job opening. Refused once applications reference it — close it instead',
  })
  deleteJobOpening(
    @Headers('x-tenant-id') tenantId: string,
    @Param('jobOpeningId') jobOpeningId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.JOB_OPENING.DELETE, {
      tenantId,
      jobOpeningId,
    });
  }

  // ==========================================
  // Candidates + the Candidate Pipeline board
  // ==========================================

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('candidates/pipeline')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Candidate Pipeline board — one column per funnel stage with its full total and the top N cards. Rejected candidates are not a column',
  })
  getCandidatePipeline(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetCandidatePipelineQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.GET_PIPELINE, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('candidates/export')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EXPORT)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({ summary: 'Export the filtered candidates as CSV' })
  async exportCandidates(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: ExportCandidatesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return sendCsvExport<any>(
      res,
      this.tenantClient,
      MESSAGE_PATTERNS.CANDIDATE.EXPORT,
      { tenantId, query },
      'candidates',
      [
        { header: 'Candidate', value: (row) => row.name },
        { header: 'Email', value: (row) => row.email },
        { header: 'Phone', value: (row) => row.phone },
        { header: 'Position', value: (row) => row.jobOpening?.title },
        {
          header: 'Requisition',
          value: (row) => row.jobOpening?.requisitionCode,
        },
        {
          header: 'Department',
          value: (row) => row.jobOpening?.department?.name,
        },
        { header: 'Source', value: (row) => row.source },
        { header: 'Stage', value: (row) => row.stage },
        { header: 'Experience (years)', value: (row) => row.yearsOfExperience },
        { header: 'Expected Salary', value: (row) => row.expectedSalary },
        { header: 'Rating', value: (row) => row.rating },
        { header: 'Interviews', value: (row) => row.interviewsCount },
        { header: 'Applied On', value: (row) => row.appliedAt },
        { header: 'Referred By', value: (row) => row.referredBy?.name },
      ],
    );
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('candidates')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Candidate list — paginated and searchable, filterable by stage, requisition, department, source and application date range',
  })
  getCandidates(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetCandidatesQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Post('candidates')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.CREATE)
  @RequirePermissions('recruitment.create', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Add an application. One application per person per requisition; a duplicate is rejected rather than creating a second pipeline card',
  })
  createCandidate(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: CreateCandidateDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.CREATE, {
      tenantId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('candidates/:candidateId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiParam({ name: 'candidateId', description: 'Candidate ID' })
  @ApiOperation({
    summary: 'One candidate with their requisition and referrer',
  })
  getCandidate(
    @Headers('x-tenant-id') tenantId: string,
    @Param('candidateId') candidateId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.GET_ONE, {
      tenantId,
      candidateId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('candidates/:candidateId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'candidateId', description: 'Candidate ID' })
  @ApiOperation({
    summary:
      'Edit a candidate. Stage is not editable here — use the stage route, which is what maintains the funnel and the activity feed',
  })
  updateCandidate(
    @Headers('x-tenant-id') tenantId: string,
    @Param('candidateId') candidateId: string,
    @Body() dto: UpdateCandidateDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.UPDATE, {
      tenantId,
      candidateId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('candidates/:candidateId/stage')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'candidateId', description: 'Candidate ID' })
  @ApiOperation({
    summary:
      'Move a candidate between pipeline columns. Moving to HIRED also opens their onboarding record with the default checklist and returns its id; HIRED is terminal',
  })
  moveCandidateStage(
    @Headers('x-tenant-id') tenantId: string,
    @Param('candidateId') candidateId: string,
    @Body() dto: MoveCandidateStageDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.MOVE_STAGE, {
      tenantId,
      candidateId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Delete('candidates/:candidateId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.DELETE)
  @RequirePermissions('recruitment.delete', 'recruitment.manage')
  @ApiParam({ name: 'candidateId', description: 'Candidate ID' })
  @ApiOperation({
    summary:
      'Delete an application and its interviews. The activity feed keeps its history — those entries hold snapshots',
  })
  deleteCandidate(
    @Headers('x-tenant-id') tenantId: string,
    @Param('candidateId') candidateId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CANDIDATE.DELETE, {
      tenantId,
      candidateId,
    });
  }

  // ==========================================
  // Interviews
  // ==========================================

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('interviews/upcoming')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Upcoming Interviews panel — the next still-scheduled interviews inside the window, soonest first, each with its end time and mode',
  })
  getUpcomingInterviews(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetUpcomingInterviewsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.GET_UPCOMING, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('interviews')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Interview list — paginated, filterable by candidate, requisition, status, mode and scheduled range',
  })
  getInterviews(
    @Headers('x-tenant-id') tenantId: string,
    @Query() query: GetInterviewsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.GET_ALL, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Post('interviews')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.CREATE)
  @RequirePermissions('recruitment.create', 'recruitment.manage')
  @ApiOperation({
    summary:
      'Schedule an interview. An online interview needs a meeting link and an in-office one a location; overlapping interviews for the same candidate are refused, and the candidate is advanced to the interview stage if they are behind it',
  })
  scheduleInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: ScheduleInterviewDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.SCHEDULE, {
      tenantId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Get('interviews/:interviewId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.VIEW)
  @RequirePermissions('recruitment.view', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({ summary: 'One interview with its candidate and interviewer' })
  getInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.GET_ONE, {
      tenantId,
      interviewId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('interviews/:interviewId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({
    summary:
      'Edit an interview mode, interviewer, link, location or notes. Use the reschedule route to change the time',
  })
  updateInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
    @Body() dto: UpdateInterviewDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.UPDATE, {
      tenantId,
      interviewId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('interviews/:interviewId/reschedule')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({
    summary:
      'Move a scheduled interview to a new time; the overlap check is re-run and the move is recorded on the activity feed',
  })
  rescheduleInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
    @Body() dto: RescheduleInterviewDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.RESCHEDULE, {
      tenantId,
      interviewId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('interviews/:interviewId/feedback')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({
    summary:
      "Record the interviewer's outcome and score, completing the interview. The candidate's aggregate rating is recomputed across every rated round; the pipeline move stays an explicit decision on the board",
  })
  submitInterviewFeedback(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
    @Body() dto: SubmitInterviewFeedbackDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.SUBMIT_FEEDBACK, {
      tenantId,
      interviewId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Patch('interviews/:interviewId/cancel')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.EDIT)
  @RequirePermissions('recruitment.edit', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({
    summary:
      'Cancel a scheduled interview with an optional reason. A completed interview cannot be cancelled',
  })
  cancelInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
    @Body() dto: CancelInterviewDto,
    @CurrentUser('id') actorUserId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.CANCEL, {
      tenantId,
      interviewId,
      dto,
      actorUserId,
    });
  }

  @ApiTags(TAGS.ORG_RECRUITMENT)
  @Delete('interviews/:interviewId')
  @RequireModule(HRMSModuleKey.RECRUITMENT, ModuleAction.DELETE)
  @RequirePermissions('recruitment.delete', 'recruitment.manage')
  @ApiParam({ name: 'interviewId', description: 'Interview ID' })
  @ApiOperation({
    summary:
      'Delete an interview record outright. Cancelling is usually the right action — it keeps the history',
  })
  deleteInterview(
    @Headers('x-tenant-id') tenantId: string,
    @Param('interviewId') interviewId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INTERVIEW.DELETE, {
      tenantId,
      interviewId,
    });
  }
}
