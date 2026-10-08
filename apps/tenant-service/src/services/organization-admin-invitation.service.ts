import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { firstValueFrom, timeout } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { OrganizationAdminInvitation, InvitationStatus } from '../models/organization-admin-invitation.model';
import { Tenant, TenantStatus, TenantSetupStatus, TenantProvisioningStatus } from '../models/tenant.model';
import { TenantService } from './tenant.service';
import { PlatformNotifierService } from './platform-notifier.service';

export interface AdminInvitationResult {
  invitationId: string;
  tenantId: string;
  adminEmail: string;
  adminName?: string;
  rawToken: string;
  activationUrl: string;
  expiresAt: Date;
  status: InvitationStatus;
}

@Injectable()
export class OrganizationAdminInvitationService {
  private readonly logger = new Logger(OrganizationAdminInvitationService.name);

  constructor(
    @InjectModel(OrganizationAdminInvitation)
    private invitationModel: typeof OrganizationAdminInvitation,
    private tenantService: TenantService,
    private readonly config: ConfigService,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    @Optional() private readonly platformNotifier?: PlatformNotifierService,
  ) {}

  /**
   * Hash a raw invitation token safely using SHA-256 (Phase F)
   */
  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Where the "Accept Invitation & Setup Account" button in the email points.
   *
   * This addresses the *frontend*, not this API. It used to be built as
   * `http://localhost:3000/api/v1/organization-admin/activate?token=…`, which
   * could not work from an email on two counts: that path is a POST handler, so
   * following the link issued a GET it would never answer, and the host was
   * hardcoded to a developer's machine. The onboarding page is what knows how
   * to validate the token, collect a password and call `activate`.
   */
  private buildActivationUrl(rawToken: string): string {
    const configured = this.config.get<string>('FRONTEND_URL');

    if (!configured) {
      // Warn rather than throw: an unreachable link is a bad invitation, but
      // failing here would roll back an organization that is otherwise fine.
      this.logger.warn(
        'FRONTEND_URL is not set — invitation links will point at the default development host. ' +
          'Set it to the portal origin (e.g. https://app.example.com) before sending real invitations.',
      );
    }

    const origin = (configured || 'http://localhost:5173').replace(/\/+$/, '');
    return `${origin}/onboarding?token=${encodeURIComponent(rawToken)}`;
  }

  /**
   * Create an Organization Admin Invitation (Phase E, F)
   */
  async createAdminInvitation(
    tenantId: string,
    adminEmail?: string,
    adminName?: string,
    createdBy?: string,
    phone?: string,
    customMessage?: string,
  ): Promise<AdminInvitationResult> {
    const tenant = await this.tenantService.getTenantById(tenantId);

    if (tenant.status === TenantStatus.SUSPENDED || !tenant.isActive) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This organization is deactivated. Activate it before sending an invitation.',
      );
    }

    if (tenant.provisioningStatus !== TenantProvisioningStatus.READY) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Cannot invite Admin. Organization database provisioning status is '${tenant.provisioningStatus}'. Database must be READY.`,
      );
    }

    const targetEmail = adminEmail || tenant.adminEmail || tenant.email;
    if (!targetEmail) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Admin email is required to generate an invitation.',
      );
    }

    // A resend (or a re-invite without a name) keeps the admin's own details
    // from the earlier invitation — falling back to the organization's name
    // made the org name become the admin's first/last name on activation.
    const previous = adminName && phone ? null : await this.findPreviousAdminDetails(tenant, targetEmail);
    const resolvedAdminName = adminName || previous?.adminName || null;
    const resolvedPhone = phone || previous?.phone || null;

    // Cancel existing PENDING invitations for this tenant
    await this.invitationModel.update(
      { status: InvitationStatus.CANCELLED, cancelledAt: new Date() },
      { where: { tenantId, status: InvitationStatus.PENDING } },
    );

    // Cryptographically secure token generation (Phase F)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 Days Expiry

    const invitation = await this.invitationModel.create({
      tenantId: tenant.id,
      adminEmail: targetEmail,
      adminName: resolvedAdminName,
      phone: resolvedPhone,
      customMessage,
      tokenHash,
      status: InvitationStatus.PENDING,
      expiresAt,
      createdBy,
    });

    const activationUrl = this.buildActivationUrl(rawToken);
    this.logger.log(`Created Admin Invitation for tenant ${tenant.id} (${targetEmail}).`);

    // Dispatch invitation email via Auth Service (TCP)
    try {
      await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.MAIL.SEND_TEMPLATE_EMAIL, {
            to: targetEmail,
            subject: `Invitation to Join ${tenant.organizationName || tenant.name} as Administrator`,
            templateName: 'admin_invitation',
            variables: {
              firstName: resolvedAdminName || 'Admin',
              organizationName: tenant.organizationName || tenant.name,
              invitationLink: activationUrl,
              expiresAt: expiresAt.toDateString(),
              customMessage: customMessage || undefined,
            },
          })
          .pipe(timeout(15000)),
      );
      this.logger.log(`Invitation email successfully dispatched to ${targetEmail}.`);
    } catch (mailErr: any) {
      this.logger.error(`Failed to dispatch invitation email to ${targetEmail}: ${mailErr.message}`);
    }

    return {
      invitationId: invitation.id,
      tenantId: tenant.id,
      adminEmail: targetEmail,
      adminName: invitation.adminName,
      rawToken,
      activationUrl,
      expiresAt,
      status: InvitationStatus.PENDING,
    };
  }

  /**
   * Resend / Replace Admin Invitation (Phase L)
   */
  async resendAdminInvitation(tenantId: string): Promise<AdminInvitationResult> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    const accepted = await this.invitationModel.count({
      where: { tenantId, status: InvitationStatus.ACCEPTED },
    });
    if (accepted > 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        "This organization's admin has already activated their account, so there is no invitation to resend.",
      );
    }
    // No name passed on purpose: `createAdminInvitation` carries the admin's
    // own name/phone over from the previous invitation.
    return this.createAdminInvitation(tenant.id, tenant.adminEmail);
  }

  /**
   * The admin's own name/phone from the most recent earlier invitation to
   * this email. Invitations created by the old resend path stored the
   * organization's name as `adminName`, so those are skipped.
   */
  private async findPreviousAdminDetails(
    tenant: { id: string; name?: string; organizationName?: string },
    adminEmail: string,
  ): Promise<{ adminName: string | null; phone: string | null } | null> {
    const orgNames = new Set(
      [tenant.name, tenant.organizationName].filter(Boolean).map((n) => n!.trim().toLowerCase()),
    );
    const invitations = await this.invitationModel.findAll({
      where: { tenantId: tenant.id, adminEmail },
      order: [['createdAt', 'DESC']],
    });
    const named = invitations.find(
      (inv) => inv.adminName && !orgNames.has(inv.adminName.trim().toLowerCase()),
    );
    return {
      adminName: named?.adminName || null,
      phone: invitations.find((inv) => inv.phone)?.phone || null,
    };
  }

  /**
   * Validate Invitation Token (Phase G)
   */
  async validateInvitationToken(rawToken: string) {
    if (!rawToken) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Invitation token is required.',
      );
    }

    const tokenHash = this.hashToken(rawToken);
    const invitation = await this.invitationModel.findOne({
      where: { tokenHash },
      include: [Tenant],
    });

    if (!invitation) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Invalid or non-existent invitation token.',
      );
    }

    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This invitation has already been accepted and activated.',
      );
    }

    // Checked before the invitation's own status: an invitation withdrawn by
    // deactivation should say why while the organization is still off.
    const owner = invitation.tenant;
    if (owner && (owner.status === TenantStatus.SUSPENDED || !owner.isActive)) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This organization has been deactivated, so its invitation can no longer be used. Please contact your platform administrator.',
      );
    }

    if (invitation.status === InvitationStatus.CANCELLED) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This invitation has been withdrawn or replaced by a newer one. Please use the most recent invitation email, or contact your platform administrator.',
      );
    }

    if (invitation.status !== InvitationStatus.PENDING) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'This invitation has expired. Please request a new invitation from your platform administrator.',
      );
    }

    // Check expiry
    if (new Date() > new Date(invitation.expiresAt)) {
      await invitation.update({ status: InvitationStatus.EXPIRED });
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Invitation token has expired. Please request a new invitation from your platform administrator.',
      );
    }

    const tenant = invitation.tenant;
    if (!tenant || tenant.provisioningStatus !== TenantProvisioningStatus.READY) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Organization database is not ready for activation.',
      );
    }

    return {
      isValid: true,
      invitationId: invitation.id,
      tenantId: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      adminEmail: invitation.adminEmail,
      adminName: invitation.adminName,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Activate Admin Account (Phase H, I, J, K, P)
   */
  async activateAdminAccount(data: {
    token: string;
    password: string;
    confirmPassword?: string;
    firstName?: string;
    lastName?: string;
  }) {
    if (data.confirmPassword && data.password !== data.confirmPassword) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Password and confirm password do not match.',
      );
    }

    // Step 1: Validate Token
    await this.validateInvitationToken(data.token);

    const tokenHash = this.hashToken(data.token);
    const invitation = await this.invitationModel.findOne({
      where: { tokenHash },
      include: [Tenant],
    });

    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'Invitation is not valid for activation.',
      );
    }

    const tenant = invitation.tenant;

    // Step 2: Create Admin User in Tenant Database via User Service (TCP)
    try {
      await firstValueFrom(
        this.userClient
          .send(MESSAGE_PATTERNS.USER.CREATE_ORGANIZATION_ADMIN, {
            tenantId: tenant.id,
            email: invitation.adminEmail,
            firstName: data.firstName || invitation.adminName || 'Admin',
            lastName: data.lastName || '',
          })
          .pipe(timeout(10000)),
      );
    } catch (err: any) {
      this.logger.error(`Failed to create Admin User in User Service: ${err.message}`);
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `User creation failed: ${err.message}`,
      );
    }

    // Step 3: Create Auth Credentials via Auth Service (TCP)
    try {
      await firstValueFrom(
        this.authClient
          .send(MESSAGE_PATTERNS.AUTH.CREATE_ADMIN_CREDENTIAL, {
            email: invitation.adminEmail,
            password: data.password,
            tenantId: tenant.id,
            tenantName: tenant.organizationName || tenant.name,
            role: 'Admin',
            firstName: data.firstName || invitation.adminName?.split(' ')[0] || 'Admin',
            lastName: data.lastName || invitation.adminName?.split(' ').slice(1).join(' ') || '',
          })
          .pipe(timeout(10000)),
      );
    } catch (err: any) {
      this.logger.error(`Failed to create Auth Credentials in Auth Service: ${err.message}`);
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Auth credential creation failed: ${err.message}`,
      );
    }

    // Step 4: Mark Invitation ACCEPTED
    await invitation.update({
      status: InvitationStatus.ACCEPTED,
      acceptedAt: new Date(),
    });

    // Step 5: Transition Tenant Lifecycle to SETUP_IN_PROGRESS (Phase P)
    await tenant.update({
      status: TenantStatus.SETUP_IN_PROGRESS,
      setupStatus: TenantSetupStatus.IN_PROGRESS,
      provisioningStatus: TenantProvisioningStatus.READY,
    });

    this.logger.log(
      `Organization Admin (${invitation.adminEmail}) activated for tenant ${tenant.id}. Tenant status: SETUP_IN_PROGRESS.`,
    );
    this.platformNotifier?.account(
      `${tenant.organizationName || tenant.name}: admin activated their account`,
      `${invitation.adminEmail} accepted the invitation and is now setting up the organization.`,
    );

    return {
      message:
        'Organization Admin account activated successfully. Please log in to complete your organization setup.',
      tenantId: tenant.id,
      adminEmail: invitation.adminEmail,
      status: TenantStatus.SETUP_IN_PROGRESS,
      setupStatus: TenantSetupStatus.IN_PROGRESS,
      provisioningStatus: TenantProvisioningStatus.READY,
    };
  }
}
