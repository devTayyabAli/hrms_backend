import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { firstValueFrom } from 'rxjs';
import { sendPdf } from '../utils/send-pdf';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  HRMSModuleKey,
  ModuleAction,
  ApplyMyLeaveDto,
  CheckOutDto,
  CreateMyRequestDto,
  DataScope,
  DecideEmployeeRequestDto,
  grantsPermission,
  GetEmployeeDocumentsQueryDto,
  GetEmployeeRequestsQueryDto,
  GetMyAttendanceQueryDto,
  EmployeeDocumentCategory,
  GetMyDocumentsQueryDto,
  GetMyLeaveHistoryQueryDto,
  GetMyLeaveSummaryQueryDto,
  GetMyNotificationsQueryDto,
  ReimbursementDto,
  UpdateMyLeaveDto,
  ReviewEmployeeDocumentDto,
  TaxYearQueryDto,
  UpdateMyProfileDto,
  UpdateMyDocumentDto,
  UpdateMyRequestDto,
  UploadMyDocumentDto,
  UploadMyDocumentFormDto,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { MAX_UPLOAD_BYTES, sendFileResponse } from '../utils/file-response.helper';

/**
 * The file store only checks that a file belongs to the tenant, so without
 * this any employee could attach — and then read through their own
 * document — a file a colleague uploaded. Returns the file's real name, size
 * and type so the document row cannot misdescribe it.
 */
async function resolveOwnFile(
  authClient: ClientProxy,
  tenantId: string,
  userId: string,
  fileId: string,
): Promise<{ fileName: string; mimeType?: string; sizeBytes: number }> {
  const result: any = await firstValueFrom(
    authClient.send(MESSAGE_PATTERNS.FILE.GET_METADATA, { fileId, userTenantId: tenantId }),
  );
  const file = result?.data;
  if (!file || file.uploadedBy !== userId) {
    throw new ForbiddenException('You can only attach a file you uploaded yourself.');
  }
  return {
    fileName: file.originalName,
    mimeType: file.mimeType ?? undefined,
    sizeBytes: Number(file.size ?? 0),
  };
}

/**
 * Best effort: the document change is already committed, so a stored file
 * that cannot be removed is logged as an orphan rather than failing the call.
 */
async function deleteStoredFile(
  authClient: ClientProxy,
  logger: Logger,
  tenantId: string,
  fileId: string,
): Promise<void> {
  try {
    await firstValueFrom(
      authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, { fileId, userTenantId: tenantId }),
    );
  } catch (error: any) {
    logger.warn(`Stored file ${fileId} could not be deleted: ${error?.message ?? error}`);
  }
}

/** Stream a document's bytes. Images and PDFs open inline so the viewer can preview them. */
async function streamStoredFile(
  authClient: ClientProxy,
  res: Response,
  tenantId: string,
  fileId: string,
) {
  const result: any = await firstValueFrom(
    authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, { fileId, userTenantId: tenantId }),
  );
  if (result && result.buffer) return sendFileResponse(res, result, true);
  return res.status(404).json({ message: 'File stream unavailable.' });
}

/**
 * The address a punch came from, for the organization's IP restriction. The
 * web app reaches the gateway through its own proxy, so the browser's
 * address is the first X-Forwarded-For hop rather than the socket peer.
 */
const clientIpOf = (req: Request): string | undefined => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return (first || req.ip || req.socket?.remoteAddress || undefined)?.slice(0, 64);
};

/**
 * Employee portal. Each route uses the signed-in user and returns only the
 * employee record linked by Employee.userId — an admin calling these sees
 * their own profile, not the directory.
 */
@Controller('organization/me')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class EmployeePortalController {
  private readonly logger = new Logger('EmployeeDocuments');

  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  @Get('dashboard')
  @ApiOperation({
    summary: 'My Dashboard — profile, today attendance, leave balances, pending requests, recent notifications',
  })
  getDashboard(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DASHBOARD, { tenantId, userId, email });
  }

  @Get('team')
  @ApiOperation({
    summary:
      'My Team — my manager and peers, my direct reports with today’s status, and every member of a department I head',
  })
  getMyTeam(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TEAM, { tenantId, userId, email });
  }

  @Get('hierarchy')
  @ApiOperation({
    summary:
      'Organization chart — the whole organization for HR and admins, a lead’s own branch for team leads and department heads',
  })
  getHierarchy(@Headers('x-tenant-id') tenantId: string, @CurrentUser() user: any) {
    // Organization-wide employee access only: a TEAM- or DEPARTMENT-scoped
    // manager sees their branch, like any other lead.
    const orgWide = !user?.dataScope || user.dataScope === DataScope.ORGANIZATION;
    const canViewAll =
      Boolean(user?.isFullAccess) ||
      (orgWide &&
        (grantsPermission(user?.permissions ?? [], 'employee.view') ||
          grantsPermission(user?.permissions ?? [], 'employee.manage')));
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_HIERARCHY, {
      tenantId,
      userId: user?.id,
      email: user?.email,
      canViewAll,
    });
  }

  // ── My Payslips ─────────────────────────────────────────────────────────
  // No employee id is ever taken from the request: the service works out
  // whose payslips these are from the signed-in login, and another person's
  // payslip reads as not found.

  @Get('payslips')
  @ApiOperation({ summary: 'My Payslips — my payslips from completed payrolls, newest first' })
  getMyPayslips(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIPS, { tenantId, userId, email });
  }

  @Get('payslips/:payslipId')
  @ApiParam({ name: 'payslipId' })
  @ApiOperation({ summary: 'One of my payslips' })
  getMyPayslip(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Param('payslipId', ParseUUIDPipe) payslipId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIP, { tenantId, userId, email, payslipId });
  }

  @Get('payslips/:payslipId/pdf')
  @ApiParam({ name: 'payslipId' })
  @ApiOperation({ summary: 'Download one of my payslips as a PDF' })
  async getMyPayslipPdf(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Param('payslipId', ParseUUIDPipe) payslipId: string, @Res() res: Response) {
    const pdf = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_PAYSLIP_PDF, { tenantId, userId, email, payslipId }),
    );
    return sendPdf(res, pdf as any);
  }

  // ── My annual tax ───────────────────────────────────────────────────────
  // Same rule as payslips: ownership comes from the login, never a parameter.

  @Get('tax-summary')
  @ApiOperation({ summary: 'My tax year so far — salary paid and income tax deducted, from approved payrolls' })
  getMyTaxSummary(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Query() query: TaxYearQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_SUMMARY, { tenantId, userId, email, taxYear: query.taxYear });
  }

  @Get('tax-certificates')
  @ApiOperation({ summary: 'My issued tax certificates, newest first' })
  getMyTaxCertificates(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_CERTIFICATES, { tenantId, userId, email });
  }

  @Get('tax-certificates/:certificateId/pdf')
  @ApiParam({ name: 'certificateId' })
  @ApiOperation({ summary: 'Download one of my tax certificates as a PDF' })
  async getMyTaxCertificatePdf(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Param('certificateId', ParseUUIDPipe) certificateId: string, @Res() res: Response) {
    const pdf = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_TAX_CERTIFICATE_PDF, { tenantId, userId, email, certificateId }),
    );
    return sendPdf(res, pdf as any);
  }

  // ── My compensation ─────────────────────────────────────────────────────
  // Ownership from the login, as everywhere here.

  @Get('compensation')
  @ApiOperation({ summary: 'My compensation, salary history, recurring items and loan / advance balances' })
  getMyCompensation(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_COMPENSATION, { tenantId, userId, email });
  }

  @Get('reimbursements')
  @ApiOperation({ summary: 'My expense claims and their status' })
  getMyReimbursements(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_MY_REIMBURSEMENTS, { tenantId, userId, email });
  }

  @Post('reimbursements')
  @ApiOperation({ summary: 'Submit an expense claim for myself — payroll approves it before it is paid' })
  submitMyReimbursement(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Body() dto: ReimbursementDto) {
    // Any employeeId in the body is ignored: the claim is the caller's own.
    const { employeeId: _ignored, ...claim } = dto;
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.SUBMIT_MY_REIMBURSEMENT, { tenantId, userId, email, dto: claim });
  }

  @Post('payslips/:payslipId/email')
  @ApiParam({ name: 'payslipId' })
  @ApiOperation({ summary: 'Email one of my payslips to the address HR has on file for me' })
  emailMyPayslip(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Param('payslipId', ParseUUIDPipe) payslipId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.EMAIL_MY_PAYSLIP, { tenantId, userId, email, payslipId });
  }

  @Get('leadership')
  @ApiOperation({ summary: 'Whether I lead anyone — direct reports and departments I head' })
  getLeadership(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEADERSHIP, { tenantId, userId, email });
  }

  @Get('profile')
  @ApiOperation({ summary: 'My Profile' })
  getProfile(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_PROFILE, { tenantId, userId, email });
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update own phone or photo. Job, department and status stay with HR' })
  updateProfile(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: UpdateMyProfileDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_PROFILE, {
      tenantId,
      userId, email,
      dto,
    });
  }

  @Get('attendance/today')
  @ApiOperation({ summary: 'Today’s attendance status, check-in and check-out' })
  getAttendanceToday(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_ATTENDANCE_TODAY, {
      tenantId,
      userId, email,
    });
  }

  @Post('attendance/check-in')
  @ApiOperation({
    summary:
      'Punch in for today. Present or Late is decided by the organization working hours and grace period, the same rule the HR screen uses',
  })
  checkIn(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Req() req: Request) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CHECK_IN, {
      tenantId,
      userId, email,
      clientIp: clientIpOf(req),
    });
  }

  @Post('attendance/check-out')
  @ApiOperation({ summary: 'Punch out for today and record the hours worked, with an optional day-end status' })
  checkOut(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string, @Req() req: Request, @Body() dto: CheckOutDto = {}) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CHECK_OUT, {
      tenantId,
      userId, email,
      clientIp: clientIpOf(req),
      dayEndStatus: dto?.dayEndStatus,
    });
  }

  @Get('attendance')
  @ApiOperation({ summary: 'Attendance tab — one month of days plus present, late, absent and on-leave counts' })
  getAttendance(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyAttendanceQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_ATTENDANCE, {
      tenantId,
      userId, email,
      query,
    });
  }

  @Get('leave/summary')
  @ApiOperation({
    summary:
      'My Leave cards — per leave type allocation, used, pending, remaining and available for the fiscal year (April–March), totals, and upcoming leave',
  })
  getLeaveSummary(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyLeaveSummaryQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE_SUMMARY, {
      tenantId,
      userId, email,
      query,
    });
  }

  @Get('leave/history')
  @ApiOperation({
    summary:
      'Leave History — paginated, filterable by status, leave type and fiscal year, with HR’s decision note and whether Edit / Cancel are available',
  })
  getLeaveHistory(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyLeaveHistoryQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE_HISTORY, {
      tenantId,
      userId, email,
      query,
    });
  }

  @Post('leave/preview')
  @ApiOperation({
    summary:
      'Apply Leave dialog check — working days to be deducted, balance before and after, overlaps, and whether it can be submitted. Saves nothing',
  })
  previewLeave(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: ApplyMyLeaveDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.PREVIEW_LEAVE, { tenantId, userId, email, dto });
  }

  @Get('leave/:leaveRequestId')
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  @ApiOperation({ summary: 'One of my leave requests, including HR’s decision note' })
  getLeave(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('leaveRequestId', ParseUUIDPipe) leaveRequestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_LEAVE, {
      tenantId,
      userId, email,
      leaveRequestId,
    });
  }

  @Patch('leave/:leaveRequestId')
  @ApiParam({ name: 'leaveRequestId', format: 'uuid' })
  @ApiOperation({
    summary: 'Edit a pending leave request — type, dates, half day or reason. Checked like a new application',
  })
  updateLeave(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('leaveRequestId', ParseUUIDPipe) leaveRequestId: string,
    @Body() dto: UpdateMyLeaveDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_LEAVE, {
      tenantId,
      userId, email,
      leaveRequestId,
      dto,
    });
  }

  @Post('leave')
  @ApiOperation({
    summary:
      'Apply Leave. Deducts working days only (or 0.5 for a half day), refuses paid leave beyond the available balance, and is always pending until HR decides',
  })
  applyLeave(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: ApplyMyLeaveDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.APPLY_LEAVE, { tenantId, userId, email, dto });
  }

  @Patch('leave/:leaveRequestId/cancel')
  @ApiParam({ name: 'leaveRequestId' })
  @ApiOperation({ summary: 'Cancel a pending leave request. Approved leave cannot be withdrawn here' })
  cancelLeave(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('leaveRequestId') leaveRequestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CANCEL_LEAVE, {
      tenantId,
      userId, email,
      leaveRequestId,
    });
  }

  @Get('documents')
  @ApiOperation({
    summary:
      'My Documents — All, Employment, Identity, Payroll, Qualification tabs with per-tab and per-status counts. Filter by status or search',
  })
  getDocuments(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyDocumentsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENTS, {
      tenantId,
      userId, email,
      query,
    });
  }

  @Post('documents/upload')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'title', 'category'],
      properties: {
        file: { type: 'string', format: 'binary' },
        title: { type: 'string', example: 'Offer Letter' },
        category: { type: 'string', enum: Object.values(EmployeeDocumentCategory) },
        expiryDate: { type: 'string', format: 'date' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  @ApiOperation({
    summary:
      'Upload Document in one step — the file plus title and category. Stored privately; status starts as Pending until HR verifies it',
  })
  async uploadDocumentFile(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() form: UploadMyDocumentFormDto,
  ) {
    if (!file) throw new BadRequestException('No file provided in form-data payload.');

    const uploaded: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
        file: {
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
        },
        tenantId,
        uploadedBy: userId,
        category: 'employee-documents',
        entityType: 'employee_document',
        isPublic: false,
      }),
    );
    const stored = uploaded?.data;
    if (!stored?.id) throw new BadRequestException('The file could not be stored.');

    try {
      return await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPLOAD_DOCUMENT, {
          tenantId,
          userId, email,
          dto: {
            ...form,
            fileId: stored.id,
            fileName: stored.originalName,
            mimeType: stored.mimeType,
            sizeBytes: Number(stored.size ?? file.size),
          },
        }),
      );
    } catch (error) {
      // The document row was refused, so nothing points at the stored file.
      await deleteStoredFile(this.authClient, this.logger, tenantId, stored.id);
      throw error;
    }
  }

  @Post('documents')
  @ApiOperation({
    summary:
      'Upload Document metadata after POST /files/upload. The file must be one you uploaded; its name, size and type are read from the file store. Status starts as Pending',
  })
  async uploadDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: UploadMyDocumentDto,
  ) {
    const file = await resolveOwnFile(this.authClient, tenantId, userId, dto.fileId);
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPLOAD_DOCUMENT, {
      tenantId,
      userId, email,
      dto: { ...dto, ...file },
    });
  }

  @Get('documents/:documentId/download')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({ summary: 'View or download one of your documents. Images and PDFs open inline' })
  async downloadDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    // Ownership is settled by the tenant service before any bytes are read.
    const document: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT, {
        tenantId,
        userId, email,
        documentId,
      }),
    );
    return streamStoredFile(this.authClient, res, tenantId, document.fileId);
  }

  @Get('documents/:documentId')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({ summary: 'One document, with HR’s review note and expiry. Get the file from /download' })
  getDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT, {
      tenantId,
      userId, email,
      documentId,
    });
  }

  @Patch('documents/:documentId')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({
    summary:
      'Edit a document that is not yet verified — title, category, expiry date, or a replacement file (fileId from POST /files/upload). Sends it back to Pending',
  })
  async updateDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: UpdateMyDocumentDto,
  ) {
    const file = dto.fileId
      ? await resolveOwnFile(this.authClient, tenantId, userId, dto.fileId)
      : {};
    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_DOCUMENT, {
        tenantId,
        userId, email,
        documentId,
        dto: { ...dto, ...file },
      }),
    );
    const { replacedFileId, ...document } = result ?? {};
    if (replacedFileId) {
      await deleteStoredFile(this.authClient, this.logger, tenantId, replacedFileId);
    }
    return document;
  }

  @Delete('documents/:documentId')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({ summary: 'Remove one of your documents and its file. Verified documents cannot be removed' })
  async deleteDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    const result: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.DELETE_DOCUMENT, {
        tenantId,
        userId, email,
        documentId,
      }),
    );
    if (result?.fileId) {
      await deleteStoredFile(this.authClient, this.logger, tenantId, result.fileId);
    }
    return { message: result?.message ?? 'Document deleted successfully' };
  }

  @Get('requests')
  @ApiOperation({
    summary: 'My Requests — the four request cards, history rows, and the pending count',
  })
  getRequests(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_REQUESTS, { tenantId, userId, email });
  }

  @Post('requests')
  @ApiOperation({
    summary: 'New request — Attendance Correction, Work From Home, Overtime, or General HR Request',
  })
  createRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateMyRequestDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CREATE_REQUEST, {
      tenantId,
      userId, email,
      dto,
    });
  }

  @Patch('requests/:requestId')
  @ApiParam({ name: 'requestId' })
  @ApiOperation({ summary: 'Edit a pending request — only permitted while status is PENDING' })
  updateRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('requestId') requestId: string,
    @Body() dto: UpdateMyRequestDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPDATE_REQUEST, {
      tenantId,
      userId, email,
      requestId,
      dto,
    });
  }

  @Delete('requests/:requestId')
  @ApiParam({ name: 'requestId' })
  @ApiOperation({ summary: 'Delete a pending request — only permitted while status is PENDING' })
  deleteRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('requestId') requestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.DELETE_REQUEST, {
      tenantId,
      userId, email,
      requestId,
    });
  }

  @Patch('requests/:requestId/cancel')
  @ApiParam({ name: 'requestId' })
  @ApiOperation({ summary: 'Cancel a pending HR request' })
  cancelRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('requestId') requestId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.CANCEL_REQUEST, {
      tenantId,
      userId, email,
      requestId,
    });
  }

  @Get('notifications')
  @ApiOperation({ summary: 'Notifications feed with unread count and a relative time label' })
  getNotifications(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyNotificationsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_NOTIFICATIONS, {
      tenantId,
      userId, email,
      query,
    });
  }

  @Post('notifications/read-all')
  @ApiOperation({ summary: 'Mark every notification as read' })
  markAllRead(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.MARK_ALL_NOTIFICATIONS_READ, {
      tenantId,
      userId, email,
    });
  }

  @Patch('notifications/:notificationId/read')
  @ApiParam({ name: 'notificationId' })
  @ApiOperation({ summary: 'Clear the unread dot on one notification' })
  markRead(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('notificationId') notificationId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.MARK_NOTIFICATION_READ, {
      tenantId,
      userId, email,
      notificationId,
    });
  }
}

/**
 * HR actions that change badges the employee portal only displays:
 * document Verified / Rejected, and request Approved / Rejected.
 */
@Controller('organization')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.EMPLOYEE)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class EmployeePortalReviewController {
  private readonly logger = new Logger('EmployeeDocuments');

  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  @Get('employee-documents')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary:
      'Employee Documents — every employee’s uploads, pending first. status=PENDING for the verification queue, expiringWithinDays for renewals; filter by category, employee, department or search. Includes counts per status',
  })
  listDocuments(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser('email') actorEmail: string,
    @Query() query: GetEmployeeDocumentsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.LIST_ALL_DOCUMENTS, {
      tenantId,
      actorUserId,
      actorEmail,
      query,
    });
  }

  // Before `employee-documents/:documentId`, or "stats" would be read as an id.
  @Get('employee-documents/stats')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({ summary: 'Pending / verified / rejected / this-month document counts' })
  getDocumentStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT_STATS, { tenantId });
  }

  @Get('employee-documents/:documentId/download')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({ summary: 'View or download an employee’s document to review it' })
  async downloadEmployeeDocument(
    @Headers('x-tenant-id') tenantId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res() res: Response,
  ) {
    const document: any = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.HR_GET_DOCUMENT, {
        tenantId,
        documentId,
      }),
    );
    return streamStoredFile(this.authClient, res, tenantId, document.fileId);
  }

  @Get('employee-documents/:documentId')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.VIEW)
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOperation({ summary: 'One employee document with the employee it belongs to' })
  getEmployeeDocument(
    @Headers('x-tenant-id') tenantId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.HR_GET_DOCUMENT, {
      tenantId,
      documentId,
    });
  }

  @Patch('employee-documents/:documentId/status')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'documentId' })
  @ApiOperation({
    summary:
      'Verify or reject a document uploaded from My Documents, with a note the employee sees (required to reject). The employee is notified either way; nobody reviews their own upload',
  })
  reviewDocument(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser('email') actorEmail: string,
    @Param('documentId') documentId: string,
    @Body() dto: ReviewEmployeeDocumentDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.REVIEW_DOCUMENT, {
      tenantId,
      documentId,
      actorUserId,
      actorEmail,
      dto,
    });
  }

  @Get('employee-requests')
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({
    summary: 'Employee Requests — every employee’s HR requests, filterable by status, type, department and name',
  })
  listRequests(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser('email') actorEmail: string,
    @Query() query: GetEmployeeRequestsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.LIST_ALL_REQUESTS, {
      tenantId,
      actorUserId,
      actorEmail,
      query,
    });
  }

  @Get('employee-requests/stats')
  @RequirePermissions('employee.view', 'employee.manage')
  @ApiOperation({ summary: 'Pending / approved / rejected / this-month counts, and pending by request type' })
  getRequestStats(@Headers('x-tenant-id') tenantId: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_REQUEST_STATS, { tenantId });
  }

  @Patch('employee-requests/:requestId/decision')
  @RequireModule(HRMSModuleKey.EMPLOYEE, ModuleAction.EDIT)
  @RequirePermissions('employee.edit', 'employee.manage')
  @ApiParam({ name: 'requestId' })
  @ApiOperation({ summary: 'Approve or reject an employee HR request and notify them' })
  decideRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') actorUserId: string,
    @CurrentUser('email') actorEmail: string,
    @Param('requestId') requestId: string,
    @Body() dto: DecideEmployeeRequestDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.EMPLOYEE_PORTAL.DECIDE_REQUEST, {
      tenantId,
      requestId,
      actorUserId,
      actorEmail,
      dto,
    });
  }
}
