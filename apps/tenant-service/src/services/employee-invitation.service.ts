import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import * as crypto from 'crypto';
import { STRONG_PASSWORD_MESSAGE, STRONG_PASSWORD_REGEX } from '@app/common';
import {
  AcceptEmployeeInvitationDto,
  EmployeeInvitationStatus,
  GetEmployeeInvitationsQueryDto,
  InviteEmployeeDto,
  MESSAGE_PATTERNS,
  SERVICES,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { EmployeeInvitationLookup } from '../models/employee-invitation-lookup.model';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { TenantService } from './tenant.service';

const INVITATION_TTL_DAYS = 7;
const RPC_TIMEOUT_MS = 15000;

/**
 * Portal access for an employee.
 *
 * The employee record and the login are deliberately separate: HR can hire
 * someone, run payroll and mark attendance long before that person ever signs
 * in. This service is the bridge — it creates the account, links it back to
 * the Employee row, and leaves everything else about the employee untouched.
 *
 * Only the SHA-256 hash of each token is stored. The raw token is returned
 * once, to be emailed.
 */
@Injectable()
export class EmployeeInvitationService {
  private readonly logger = new Logger(EmployeeInvitationService.name);

  constructor(
    @InjectModel(EmployeeInvitationLookup)
    private readonly lookupModel: typeof EmployeeInvitationLookup,
    private readonly modelProvider: TenantModelProviderService,
    private readonly tenantService: TenantService,
    private readonly config: ConfigService,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) {}

  private fail(message: string, status = HttpStatus.BAD_REQUEST): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Where the email's button points. This addresses the portal frontend, not
   * this API — the page is what collects a password and calls accept.
   *
   * Carries only the token, deliberately. An earlier version also put
   * `tenantId` in the query string so the pre-login frontend would have
   * something to send as `x-tenant-id` — but a tenant id is an internal
   * routing detail, not something that belongs in a link a browser address
   * bar (or an email client, or a proxy log) can show. `EmployeeInvitationLookup`
   * (a platform-level, token-hash -> tenantId table) now does for employee
   * invitations exactly what the organization-admin invitation table already
   * does for admins: resolve the tenant from the token alone, server-side.
   */
  private buildAcceptUrl(rawToken: string): string {
    const configured = this.config.get<string>('FRONTEND_URL');
    if (!configured) {
      this.logger.warn(
        'FRONTEND_URL is not set — employee invitation links will point at the default ' +
          'development host. Set it to the portal origin before sending real invitations.',
      );
    }
    const origin = (configured || 'http://localhost:5173').replace(/\/+$/, '');
    return `${origin}/activate?token=${encodeURIComponent(rawToken)}`;
  }

  /** Resolves a bare token back to its tenant via the platform lookup table. */
  private async resolveTenantId(rawToken: string): Promise<string> {
    if (!rawToken) this.fail('An invitation token is required.');

    const lookup = await this.lookupModel.findOne({
      where: { tokenHash: this.hashToken(rawToken) },
    });
    if (!lookup) this.fail('Invalid invitation token.', HttpStatus.NOT_FOUND);

    return lookup.tenantId;
  }

  private row(invitation: any, employee?: any) {
    return {
      id: invitation.id,
      employeeId: invitation.employeeId,
      roleId: invitation.roleId ?? null,
      employee: employee
        ? {
            id: employee.id,
            employeeCode: employee.employeeCode,
            name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
            email: employee.email,
          }
        : undefined,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt ?? null,
      revokedAt: invitation.revokedAt ?? null,
      isExpired:
        invitation.status === EmployeeInvitationStatus.PENDING &&
        new Date() > new Date(invitation.expiresAt),
      createdAt: invitation.createdAt,
    };
  }

  /**
   * Invite one employee. Any invitation still outstanding for them is
   * revoked first, so an employee never has two live links — the newest
   * email is always the one that works.
   */
  async invite(tenantId: string, dto: InviteEmployeeDto, actorUserId?: string) {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({
      where: { id: dto.employeeId, tenantId },
    });
    if (!employee) {
      this.fail('Employee not found in this organization.', HttpStatus.NOT_FOUND);
    }

    if (employee.userId) {
      this.fail('This employee already has portal access.', HttpStatus.CONFLICT);
    }

    const email = (dto.email ?? employee.email ?? '').trim();
    if (!email) {
      this.fail('This employee has no email address to invite.');
    }

    const Invitation = await this.modelProvider.getEmployeeInvitationModel(tenantId);
    await Invitation.update(
      { status: EmployeeInvitationStatus.REVOKED, revokedAt: new Date() },
      {
        where: {
          tenantId,
          employeeId: employee.id,
          status: EmployeeInvitationStatus.PENDING,
        },
      },
    );

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invitation = await Invitation.create({
      tenantId,
      employeeId: employee.id,
      email,
      tokenHash,
      status: EmployeeInvitationStatus.PENDING,
      message: dto.message ?? null,
      expiresAt,
      invitedByUserId: actorUserId ?? null,
      roleId: dto.roleId ?? null,
    });

    // Lets the activation link carry only the token — see buildAcceptUrl.
    await this.lookupModel.create({ tokenHash, tenantId, expiresAt });

    const acceptUrl = this.buildAcceptUrl(rawToken);
    await this.sendInvitationEmail(tenantId, employee, email, acceptUrl, expiresAt, dto.message);

    return {
      ...this.row(invitation, employee),
      // Returned once, for a client that shows the link or re-sends it
      // itself. It is never readable from the stored row again.
      acceptUrl,
      rawToken,
    };
  }

  /** Email dispatch must not undo a stored invitation that HR can resend. */
  private async sendInvitationEmail(
    tenantId: string,
    employee: any,
    email: string,
    acceptUrl: string,
    expiresAt: Date,
    message?: string,
  ) {
    let organizationName = 'your organization';
    try {
      const tenant = await this.tenantService.getTenantById(tenantId);
      organizationName = tenant.organizationName || tenant.name || organizationName;
    } catch {
      // Falls through to the generic name below.
    }

    try {
      await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.MAIL.SEND_TEMPLATE_EMAIL, {
            to: email,
            subject: `Your ${organizationName} employee portal access`,
            templateName: 'admin_invitation',
            variables: {
              firstName: employee.firstName || 'there',
              organizationName,
              invitationLink: acceptUrl,
              expiresAt: expiresAt.toDateString(),
              customMessage: message || undefined,
            },
          })
          .pipe(timeout(RPC_TIMEOUT_MS)),
      );
    } catch (error: any) {
      this.logger.error(
        `Employee invitation stored but the email to ${email} was not sent: ${error?.message ?? error}`,
      );
    }
  }

  async list(tenantId: string, query: GetEmployeeInvitationsQueryDto = {}) {
    const Invitation = await this.modelProvider.getEmployeeInvitationModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);

    const where: any = { tenantId };
    if (query.status) where.status = query.status;

    const rows = await Invitation.findAll({
      where,
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'email'],
          required: false,
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
    });

    return {
      total: rows.length,
      rows: (rows as any[]).map((row) => this.row(row, row.employee)),
    };
  }

  async resend(tenantId: string, invitationId: string, actorUserId?: string) {
    const Invitation = await this.modelProvider.getEmployeeInvitationModel(tenantId);
    const invitation = await Invitation.findOne({
      where: { id: invitationId, tenantId },
    });
    if (!invitation) {
      this.fail('Invitation not found.', HttpStatus.NOT_FOUND);
    }
    if (invitation.status === EmployeeInvitationStatus.ACCEPTED) {
      this.fail('This invitation has already been accepted.', HttpStatus.CONFLICT);
    }

    // Issues a fresh token rather than re-mailing the old one, so the clock
    // restarts and an intercepted earlier link stops working.
    return this.invite(
      tenantId,
      { employeeId: invitation.employeeId, email: invitation.email },
      actorUserId,
    );
  }

  async revoke(tenantId: string, invitationId: string) {
    const Invitation = await this.modelProvider.getEmployeeInvitationModel(tenantId);
    const invitation = await Invitation.findOne({
      where: { id: invitationId, tenantId },
    });
    if (!invitation) {
      this.fail('Invitation not found.', HttpStatus.NOT_FOUND);
    }
    if (invitation.status !== EmployeeInvitationStatus.PENDING) {
      this.fail(
        `Only a pending invitation can be revoked. This one is ${String(
          invitation.status,
        ).toLowerCase()}.`,
        HttpStatus.CONFLICT,
      );
    }

    await invitation.update({
      status: EmployeeInvitationStatus.REVOKED,
      revokedAt: new Date(),
    });
    return this.row(invitation);
  }

  /**
   * Looks a token up without consuming it, so the activation page can greet
   * the employee and reject a dead link before asking for a password.
   */
  async validate(rawToken: string) {
    const tenantId = await this.resolveTenantId(rawToken);
    const { invitation, employee } = await this.loadPendingByToken(tenantId, rawToken);

    let organizationName = 'your organization';
    try {
      const tenant = await this.tenantService.getTenantById(tenantId);
      organizationName = tenant.organizationName || tenant.name || organizationName;
    } catch {
      // Falls through to the generic name above.
    }

    return {
      isValid: true,
      invitationId: invitation.id,
      organizationName,
      // accept() provisions portal access with the invitation's assigned role.
      role: 'Employee' as const,
      roleId: invitation.roleId ?? null,
      employeeId: employee.id,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    };
  }

  private async loadPendingByToken(tenantId: string, rawToken: string) {
    if (!rawToken) this.fail('An invitation token is required.');

    const Invitation = await this.modelProvider.getEmployeeInvitationModel(tenantId);
    const invitation = await Invitation.findOne({
      where: { tenantId, tokenHash: this.hashToken(rawToken) },
    });
    if (!invitation) this.fail('Invalid invitation token.', HttpStatus.NOT_FOUND);

    if (invitation.status === EmployeeInvitationStatus.ACCEPTED) {
      this.fail('This invitation has already been used.', HttpStatus.CONFLICT);
    }
    if (invitation.status !== EmployeeInvitationStatus.PENDING) {
      this.fail(
        `This invitation is no longer valid (${String(invitation.status).toLowerCase()}).`,
        HttpStatus.CONFLICT,
      );
    }
    if (new Date() > new Date(invitation.expiresAt)) {
      await invitation.update({ status: EmployeeInvitationStatus.EXPIRED });
      this.fail('This invitation has expired. Ask HR to send a new one.', HttpStatus.CONFLICT);
    }

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee = await Employee.findOne({
      where: { id: invitation.employeeId, tenantId },
    });
    if (!employee) {
      this.fail('The employee this invitation belongs to no longer exists.', HttpStatus.NOT_FOUND);
    }

    return { invitation, employee };
  }

  /**
   * Turns an accepted invitation into a working login: a user-service
   * account with its assigned role in user_roles, an auth credential,
   * and the `userId` link the employee portal resolves "me" through.
   */
  async accept(dto: AcceptEmployeeInvitationDto) {
    if (dto.confirmPassword && dto.password !== dto.confirmPassword) {
      this.fail('Password and confirm password do not match.');
    }
    // Again here, not only on the gateway DTO: the user account below is
    // created before auth-service sees the password, so a password it would
    // refuse must stop the activation before anything is written.
    if (!STRONG_PASSWORD_REGEX.test(dto.password ?? '')) {
      this.fail(STRONG_PASSWORD_MESSAGE);
    }

    const tenantId = await this.resolveTenantId(dto.token);
    const { invitation, employee } = await this.loadPendingByToken(tenantId, dto.token);

    let userId: string | null = null;
    const roleIds = invitation.roleId ? [invitation.roleId] : [];
    try {
      const user: any = await firstValueFrom(
        this.userClient
          .send(MESSAGE_PATTERNS.USER.CREATE_USER, {
            tenantId,
            email: invitation.email,
            firstName: employee.firstName,
            lastName: employee.lastName,
            roleId: invitation.roleId ?? undefined,
            roleIds: roleIds.length > 0 ? roleIds : undefined,
          })
          .pipe(timeout(RPC_TIMEOUT_MS)),
      );
      userId = user?.id ?? null;
    } catch (error: any) {
      this.fail(`Could not create the employee account: ${error?.message ?? error}`);
    }

    let credentialRole = 'Employee';
    if (invitation.roleId) {
      try {
        const role: any = await firstValueFrom(
          this.userClient
            .send(MESSAGE_PATTERNS.ROLE.GET_BY_ID, {
              data: { id: invitation.roleId },
              context: { tenantId },
            })
            .pipe(timeout(RPC_TIMEOUT_MS)),
        );
        if (role?.name) {
          credentialRole = role.name;
        }
      } catch {
        // Fall back to 'Employee'
      }
    }

    try {
      await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.AUTH.CREATE_ADMIN_CREDENTIAL, {
            email: invitation.email,
            password: dto.password,
            tenantId,
            role: credentialRole,
            // Without this, the account activates with no name at all and
            // My Profile falls back to guessing one from the email — the
            // exact bug already fixed once for the org-admin invite path.
            firstName: employee.firstName,
            lastName: employee.lastName,
          })
          .pipe(timeout(RPC_TIMEOUT_MS)),
      );
    } catch (error: any) {
      this.fail(`Could not set the employee password: ${error?.message ?? error}`);
    }

    // The portal resolves the signed-in user to an Employee through this
    // column; without it the new login would fall back to the email match.
    if (userId) await employee.update({ userId });

    await invitation.update({
      status: EmployeeInvitationStatus.ACCEPTED,
      acceptedAt: new Date(),
    });

    this.logger.log(
      `Employee ${employee.id} activated portal access for tenant ${tenantId}.`,
    );

    return {
      message: 'Portal access activated. You can now sign in.',
      employeeId: employee.id,
      email: invitation.email,
      userId,
    };
  }

  /**
   * Called when the Employee record this account was tied to gets deleted.
   * Best-effort by design: an Employee is deleted either way, so a hiccup in
   * user-service or auth-service (down, timeout) must not block that delete
   * — it only means the account is deactivated a little late, not never, and
   * each call is independently scoped/idempotent so a retry is harmless.
   * `userId` is null when the invitation never completed activation (nothing
   * to deactivate in user-service in that case, but the email may still hold
   * a credential in *this* tenant if activation failed partway through).
   */
  async deactivateLinkedAccount(
    tenantId: string,
    userId: string | null,
    email: string,
  ): Promise<void> {
    await this.setLinkedAccountActive(tenantId, userId, email, false);
  }

  /**
   * Suspends or restores an employee's portal login — the user record and the
   * sign-in credential together. Best effort: an employee's status change is
   * never blocked on user-service or auth-service being unreachable, and an
   * employee who was never invited simply has nothing to change.
   */
  async setLinkedAccountActive(
    tenantId: string,
    userId: string | null,
    email: string,
    isActive: boolean,
  ): Promise<void> {
    const verb = isActive ? 'reactivate' : 'deactivate';
    if (userId) {
      try {
        await firstValueFrom(
          this.userClient
            .send(MESSAGE_PATTERNS.USER.UPDATE_USER, {
              tenantId,
              id: userId,
              data: { isActive },
            })
            .pipe(timeout(RPC_TIMEOUT_MS)),
        );
      } catch (err: any) {
        this.logger.warn(
          `Failed to ${verb} user ${userId} for tenant ${tenantId}: ${err.message}`,
        );
      }
    }

    try {
      await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.AUTH.DEACTIVATE_TENANT_CREDENTIAL, {
            email,
            tenantId,
            isActive,
          })
          .pipe(timeout(RPC_TIMEOUT_MS)),
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to ${verb} credential for ${email} in tenant ${tenantId}: ${err.message}`,
      );
    }
  }
}
