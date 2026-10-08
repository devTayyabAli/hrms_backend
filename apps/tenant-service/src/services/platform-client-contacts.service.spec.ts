import { of } from 'rxjs';
import { DirectoryRoleCategory } from '@app/database';
import { InvitationStatus, TenantStatus } from '../models';
import { PlatformClientContactsService } from './platform-client-contacts.service';

const NOW = new Date('2026-10-08T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const tenants = [
  { id: 't1', name: 'fuutura', organizationName: 'Fuutura', logoUrl: null, status: TenantStatus.ACTIVE, isActive: true },
  { id: 't2', name: 'acme', organizationName: 'Acme', logoUrl: null, status: TenantStatus.PENDING_ADMIN_ACTIVATION, isActive: true },
  { id: 't3', name: 'closed', organizationName: 'Closed Co', logoUrl: null, status: TenantStatus.SUSPENDED, isActive: false },
];

const person = (over: Record<string, any>) => ({
  tenantId: 't1',
  sourceId: 'u1',
  organizationName: null,
  name: 'Tayyab Ali',
  email: 'tayyab@fuutura.com',
  phone: null,
  role: 'ORGANIZATION_ADMIN',
  roleCategory: DirectoryRoleCategory.ADMIN,
  isActive: true,
  sourceCreatedAt: daysAgo(40),
  ...over,
});

const people = [
  person({}),
  person({ sourceId: 'u2', name: 'Tahir Ali', email: 'tahir@fuutura.com', role: 'HR', roleCategory: DirectoryRoleCategory.HR, sourceCreatedAt: daysAgo(2) }),
  person({ sourceId: 'u3', name: 'Blocked HR', email: 'blocked@fuutura.com', role: 'HR', roleCategory: DirectoryRoleCategory.HR, isActive: false }),
  person({ tenantId: 't3', sourceId: 'u4', name: 'Closed Admin', email: 'admin@closed.co' }),
  person({ tenantId: 'gone', sourceId: 'u5', name: 'Stale Row', email: 'stale@x.com' }),
];

const invitations = [
  // Latest for t2: pending, not expired.
  { id: 'i2', tenantId: 't2', adminEmail: 'owner@acme.com', adminName: 'Acme Owner', phone: null, status: InvitationStatus.PENDING, expiresAt: daysAgo(-3), createdAt: daysAgo(1) },
  // Older t2 invitation, ignored.
  { id: 'i1', tenantId: 't2', adminEmail: 'old@acme.com', adminName: 'Old', phone: null, status: InvitationStatus.CANCELLED, expiresAt: daysAgo(5), createdAt: daysAgo(10) },
  // t1's admin accepted — already listed as a user.
  { id: 'i0', tenantId: 't1', adminEmail: 'tayyab@fuutura.com', adminName: 'Tayyab Ali', phone: null, status: InvitationStatus.ACCEPTED, expiresAt: daysAgo(30), createdAt: daysAgo(40) },
];

const setup = (lastLogins: Record<string, { email: string; lastLoginAt: Date | null }[]>) => {
  const directory = {
    findAll: jest.fn(async (opts: any) =>
      opts.group
        ? [{ tenantId: 't1', count: '17' }]
        : people.filter((p) => p.roleCategory === DirectoryRoleCategory.ADMIN || p.roleCategory === DirectoryRoleCategory.HR),
    ),
  };
  return new PlatformClientContactsService(
    { findAll: async () => tenants } as any,
    directory as any,
    { findAll: async () => invitations } as any,
    { send: () => of(lastLogins) } as any,
  );
};

describe('PlatformClientContactsService', () => {
  it('lists admins and HR with their organization, readable role and status', async () => {
    const service = setup({ t1: [{ email: 'Tayyab@Fuutura.com', lastLoginAt: daysAgo(1) }, { email: 'tahir@fuutura.com', lastLoginAt: null }] });
    const { contacts } = await service.getContacts(NOW);
    const byEmail = Object.fromEntries(contacts.map((c) => [c.email, c]));

    expect(byEmail['tayyab@fuutura.com']).toMatchObject({
      organizationName: 'Fuutura', // filled from the tenant, not the empty projection column
      role: 'Organization Admin',
      status: 'active',
      organizationEmployees: 17,
    });
    expect(byEmail['tahir@fuutura.com']).toMatchObject({ role: 'HR', status: 'never_signed_in' });
    expect(byEmail['blocked@fuutura.com'].status).toBe('login_blocked');
    expect(byEmail['admin@closed.co'].status).toBe('organization_deactivated');
    expect(byEmail['stale@x.com']).toBeUndefined();
  });

  it('marks a sign-in older than 30 days as inactive', async () => {
    const service = setup({ t1: [{ email: 'tayyab@fuutura.com', lastLoginAt: daysAgo(45) }] });
    const { contacts } = await service.getContacts(NOW);
    expect(contacts.find((c) => c.email === 'tayyab@fuutura.com')!.status).toBe('inactive');
  });

  it('adds the latest pending admin invitation of an organization with no admin yet', async () => {
    const { contacts, summary } = await setup({}).getContacts(NOW);
    const invite = contacts.find((c) => c.kind === 'invitation')!;
    expect(invite).toMatchObject({
      email: 'owner@acme.com',
      organizationName: 'Acme',
      status: 'invitation_sent',
      canResendInvitation: true,
      userId: null,
    });
    expect(contacts.filter((c) => c.kind === 'invitation')).toHaveLength(1);
    expect(summary.awaitingActivation).toBe(1);
  });

  it('never includes employees — only how many each organization has', async () => {
    const { contacts } = await setup({}).getContacts(NOW);
    expect(contacts.every((c) => c.roleCategory === 'ADMIN' || c.roleCategory === 'HR')).toBe(true);
  });

  it('summarises by status and counts additions this month', async () => {
    const { summary } = await setup({ t1: [{ email: 'tayyab@fuutura.com', lastLoginAt: daysAgo(1) }] }).getContacts(NOW);
    expect(summary).toMatchObject({ total: 5, active: 1, awaitingActivation: 1, dormant: 1, blocked: 2, organizations: 3 });
    // Tahir (2 days ago) and the Acme invitation (1 day ago) are October additions.
    expect(summary.addedThisMonth.total).toBe(2);
  });
});
