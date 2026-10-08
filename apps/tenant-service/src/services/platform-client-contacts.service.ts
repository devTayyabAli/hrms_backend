import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { Op, fn, col } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';
import { DirectoryRoleCategory, PlatformDirectoryPerson } from '@app/database';
import { InvitationStatus, OrganizationAdminInvitation, Tenant, TenantStatus } from '../models';

/** Where a client contact stands, most urgent first. */
export type ClientContactStatus =
  | 'organization_deactivated'
  | 'login_blocked'
  | 'invitation_sent'
  | 'invitation_expired'
  | 'invitation_withdrawn'
  | 'never_signed_in'
  | 'inactive'
  | 'active';

export interface ClientContact {
  /** `user:<tenantId>:<userId>` or `invite:<invitationId>`. */
  key: string;
  kind: 'user' | 'invitation';
  tenantId: string;
  /** Set for activated users: the id the block/allow endpoint takes. */
  userId: string | null;
  organizationName: string;
  organizationLogoUrl: string | null;
  name: string;
  email: string;
  phone: string | null;
  /** "Organization Admin", "HR" — never a raw code like ORGANIZATION_ADMIN. */
  role: string;
  roleCategory: 'ADMIN' | 'HR';
  status: ClientContactStatus;
  lastLoginAt: Date | null;
  addedAt: Date | null;
  /** How many employees the organization has — a count only, never who. */
  organizationEmployees: number;
  /** Invitations only: a new one may be sent (organization on, admin never activated). */
  canResendInvitation: boolean;
}

/** No sign-in for this long counts as inactive. */
const INACTIVE_DAYS = 30;

/** "ORGANIZATION_ADMIN" → "Organization Admin", "hr_manager" → "HR Manager". */
const humanizeRole = (role: string | null | undefined, category: 'ADMIN' | 'HR'): string => {
  const raw = (role ?? '').trim();
  if (!raw) return category === 'ADMIN' ? 'Organization Admin' : 'HR';
  if (/^[A-Z0-9_ ]+$/.test(raw) || raw.includes('_')) {
    return raw
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((word) => (['HR', 'IT', 'CEO', 'CTO', 'CFO'].includes(word.toUpperCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
      .join(' ');
  }
  return raw;
};

/**
 * The platform's client contacts: the people who run each organization's
 * account — its admins and HR — plus admins invited but not yet activated.
 *
 * Employees are deliberately absent: they are the organizations' own people,
 * not the platform's clients, so the Super Admin sees only how many each
 * organization has.
 */
@Injectable()
export class PlatformClientContactsService {
  private readonly logger = new Logger(PlatformClientContactsService.name);

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    @InjectModel(PlatformDirectoryPerson) private readonly directoryModel: typeof PlatformDirectoryPerson,
    @InjectModel(OrganizationAdminInvitation) private readonly invitationModel: typeof OrganizationAdminInvitation,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  async getContacts(now = new Date()) {
    const [tenants, people, invitations, employeeCounts] = await Promise.all([
      this.tenantModel.findAll({ attributes: ['id', 'name', 'organizationName', 'logoUrl', 'status', 'isActive'] }),
      this.directoryModel.findAll({
        where: {
          roleCategory: { [Op.in]: [DirectoryRoleCategory.ADMIN, DirectoryRoleCategory.HR] },
          deletedAt: null,
        },
      }),
      this.invitationModel.findAll({ order: [['createdAt', 'DESC']] }),
      this.directoryModel.findAll({
        where: { roleCategory: DirectoryRoleCategory.EMPLOYEE, deletedAt: null },
        attributes: ['tenantId', [fn('COUNT', col('id')), 'count']],
        group: ['tenantId'],
        raw: true,
      }) as unknown as Promise<{ tenantId: string; count: string }[]>,
    ]);

    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const employees = new Map(employeeCounts.map((row) => [row.tenantId, Number(row.count)]));
    const lastLogins = await this.lastLogins(tenants.map((t) => t.id));

    const orgOff = (tenant: Tenant | undefined) => !tenant || tenant.status === TenantStatus.SUSPENDED || tenant.isActive === false;
    const inactiveBefore = now.getTime() - INACTIVE_DAYS * 24 * 60 * 60 * 1000;
    const contacts: ClientContact[] = [];

    for (const person of people) {
      const tenant = tenantById.get(person.tenantId);
      // A directory row for an organization that no longer exists is stale.
      if (!tenant) continue;
      const category = person.roleCategory === DirectoryRoleCategory.ADMIN ? 'ADMIN' : 'HR';
      const lastLoginAt = lastLogins.get(`${person.tenantId}:${person.email.toLowerCase()}`) ?? null;
      const status: ClientContactStatus = orgOff(tenant)
        ? 'organization_deactivated'
        : !person.isActive
          ? 'login_blocked'
          : !lastLoginAt
            ? 'never_signed_in'
            : new Date(lastLoginAt).getTime() < inactiveBefore
              ? 'inactive'
              : 'active';

      contacts.push({
        key: `user:${person.tenantId}:${person.sourceId}`,
        kind: 'user',
        tenantId: person.tenantId,
        userId: person.sourceId,
        // The projection doesn't always carry the organization's name; the tenant row always does.
        organizationName: tenant.organizationName || tenant.name || person.organizationName || '—',
        organizationLogoUrl: tenant.logoUrl ?? null,
        name: person.name || person.email,
        email: person.email,
        phone: person.phone,
        role: humanizeRole(person.role, category),
        roleCategory: category,
        status,
        lastLoginAt,
        addedAt: person.sourceCreatedAt,
        organizationEmployees: employees.get(person.tenantId) ?? 0,
        canResendInvitation: false,
      });
    }

    // Admins invited but never activated have no user yet — only their latest invitation.
    const seenTenants = new Set<string>();
    for (const invitation of invitations) {
      if (seenTenants.has(invitation.tenantId)) continue;
      seenTenants.add(invitation.tenantId);
      if (invitation.status === InvitationStatus.ACCEPTED) continue;

      const tenant = tenantById.get(invitation.tenantId);
      if (!tenant) continue;
      const alreadyListed = contacts.some(
        (c) => c.tenantId === invitation.tenantId && c.email.toLowerCase() === invitation.adminEmail.toLowerCase(),
      );
      if (alreadyListed) continue;

      const expired =
        invitation.status === InvitationStatus.EXPIRED ||
        (invitation.status === InvitationStatus.PENDING && new Date(invitation.expiresAt).getTime() < now.getTime());
      const status: ClientContactStatus = orgOff(tenant)
        ? 'organization_deactivated'
        : invitation.status === InvitationStatus.CANCELLED
          ? 'invitation_withdrawn'
          : expired
            ? 'invitation_expired'
            : 'invitation_sent';

      contacts.push({
        key: `invite:${invitation.id}`,
        kind: 'invitation',
        tenantId: invitation.tenantId,
        userId: null,
        organizationName: tenant.organizationName || tenant.name || '—',
        organizationLogoUrl: tenant.logoUrl ?? null,
        name: invitation.adminName || invitation.adminEmail,
        email: invitation.adminEmail,
        phone: invitation.phone ?? null,
        role: 'Organization Admin',
        roleCategory: 'ADMIN',
        status,
        lastLoginAt: null,
        addedAt: invitation.createdAt,
        organizationEmployees: employees.get(invitation.tenantId) ?? 0,
        canResendInvitation: !orgOff(tenant) && tenant.status === TenantStatus.PENDING_ADMIN_ACTIVATION,
      });
    }

    contacts.sort((a, b) => (b.addedAt ? new Date(b.addedAt).getTime() : 0) - (a.addedAt ? new Date(a.addedAt).getTime() : 0));

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const count = (statuses: ClientContactStatus[]) => contacts.filter((c) => statuses.includes(c.status)).length;
    const awaiting: ClientContactStatus[] = ['invitation_sent', 'invitation_expired', 'invitation_withdrawn'];
    const dormant: ClientContactStatus[] = ['never_signed_in', 'inactive'];
    const blocked: ClientContactStatus[] = ['login_blocked', 'organization_deactivated'];
    const addedThisMonth = (statuses?: ClientContactStatus[]) =>
      contacts.filter((c) => c.addedAt && new Date(c.addedAt) >= monthStart && (!statuses || statuses.includes(c.status))).length;

    return {
      contacts,
      summary: {
        total: contacts.length,
        active: count(['active']),
        awaitingActivation: count(awaiting),
        dormant: count(dormant),
        blocked: count(blocked),
        organizations: new Set(contacts.map((c) => c.tenantId)).size,
        addedThisMonth: {
          total: addedThisMonth(),
          active: addedThisMonth(['active']),
          awaitingActivation: addedThisMonth(awaiting),
          dormant: addedThisMonth(dormant),
        },
        inactiveDays: INACTIVE_DAYS,
      },
    };
  }

  /** `tenantId:email` → last sign-in, from the auth service. Missing data reads as "never". */
  private async lastLogins(tenantIds: string[]): Promise<Map<string, Date | null>> {
    const map = new Map<string, Date | null>();
    if (!tenantIds.length) return map;
    try {
      const byTenant: Record<string, { email: string; lastLoginAt: Date | null }[]> = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.AUTH.GET_LAST_LOGINS, { tenantIds }).pipe(timeout(15_000)),
      );
      for (const [tenantId, rows] of Object.entries(byTenant ?? {})) {
        for (const row of rows) map.set(`${tenantId}:${row.email.toLowerCase()}`, row.lastLoginAt ? new Date(row.lastLoginAt) : null);
      }
    } catch (error: any) {
      this.logger.warn(`Last sign-ins unavailable for client contacts: ${error?.message ?? error}`);
    }
    return map;
  }
}
