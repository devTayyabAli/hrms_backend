import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, QueryTypes, WhereOptions } from 'sequelize';
import {
  DEFAULT_PLATFORM_TIME_ZONE,
  localClock,
  parseUserAgent,
  utcOffsetMinutes,
} from '@app/common';
import { AuditLog, AuthCredential, SuperAdmin } from '../models';

export interface AuditLogEntry {
  action: string;
  actorType: 'superadmin' | 'tenant' | 'unknown';
  userId?: string;
  email?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
  module?: string;
  status?: string;
  organizationName?: string;
  organizationLogo?: string;
  userName?: string;
  userRole?: string;
  userAvatar?: string;
  actionDetails?: string;
  device?: string;
  changes?:
    Array<{ field: string; before: any; after: any }> | Record<string, any>;
  metadata?: Record<string, any>;
  createdAt?: Date;
}

export interface AuditLogQuery {
  search?: string;
  email?: string;
  action?: string;
  userId?: string;
  module?: string;
  status?: string;
  /** 'security' narrows to the events counted as Security Events. */
  category?: string;
  tenantId?: string;
  organizationId?: string;
  from?: string | Date;
  to?: string | Date;
  page?: number;
  limit?: number;
  format?: 'csv' | 'json';
}

/** Most rows a single CSV export carries. */
export const AUDIT_EXPORT_LIMIT = 10_000;

/**
 * Session renewals happen every few minutes for every signed-in user. They
 * were written to the trail until now and drowned out everything a person
 * actually did, so they're no longer recorded and older ones are left out.
 */
const NOISE_ACTIONS = ['TOKEN_REFRESH'];

/** Sign-in failures and anything touching access control. */
const SECURITY_ACTIONS = [
  'LOGIN_FAILED',
  'TWO_FA_FAILED',
  'TOKEN_REFRESH_FAILED',
  'ACCOUNT_LOCKED',
];
const SECURITY_MODULE = 'Security';

/** Failure actions are named for it (`LOGIN_FAILED`), so the action is the signal when no status is given. */
const statusForAction = (action: string): string =>
  /FAIL|DENIED|ERROR|INVALID/i.test(action) ? 'Failed' : 'Success';

/**
 * A readable device label, or nothing when the agent is unrecognisable —
 * `curl/8.19.0` and `unknown` are more informative raw than as
 * "Unknown OS / Unknown browser".
 */
const describeUserAgent = (userAgent?: string): string | undefined => {
  const { browser, operatingSystem } = parseUserAgent(userAgent);
  if (browser === 'Unknown browser' && operatingSystem === 'Unknown OS') {
    return undefined;
  }
  return `${operatingSystem} / ${browser}`;
};

const fullName = (
  person: {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null,
) =>
  person
    ? person.name?.trim() ||
      [person.firstName, person.lastName].filter(Boolean).join(' ').trim() ||
      undefined
    : undefined;

/** "org_admin" → "Org Admin". */
const roleLabel = (role?: string | null) =>
  role
    ? role
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

/**
 * The six sample rows this service used to insert into an empty table so the
 * screen had something to show. They are removed on startup; the signature is
 * exact (one shared timestamp and IP, the invented names) so nothing real can
 * match it.
 */
const SAMPLE_SIGNATURE = {
  ipAddress: '103.21.244.12',
  createdAt: new Date('2026-08-18T10:42:00.000Z'),
  userName: [
    'David Lee',
    'John Smith',
    'Emily Johnson',
    'Sophia Wang',
    'Micheal Brown',
    'Sara David',
  ],
};

const platformTimeZone = () =>
  process.env.NOTIFICATIONS_DEFAULT_TIME_ZONE || DEFAULT_PLATFORM_TIME_ZONE;

@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);
  private readonly organizationNames = new Map<
    string,
    { name: string | null; at: number }
  >();

  constructor(
    @InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog,
    @Optional()
    @InjectModel(SuperAdmin)
    private readonly superAdminModel?: typeof SuperAdmin,
    @Optional()
    @InjectModel(AuthCredential)
    private readonly credentialModel?: typeof AuthCredential,
  ) {}

  async onModuleInit() {
    try {
      const removed = await this.auditLogModel.destroy({
        where: {
          ipAddress: SAMPLE_SIGNATURE.ipAddress,
          createdAt: SAMPLE_SIGNATURE.createdAt,
          userName: { [Op.in]: SAMPLE_SIGNATURE.userName },
        },
      });
      if (removed)
        this.logger.log(
          `Removed ${removed} sample audit entries that were never real activity.`,
        );
      // 'Active' was the old word for a successful action.
      await this.auditLogModel.update(
        { status: 'Success' },
        { where: { status: 'Active' } },
      );
    } catch (err) {
      this.logger.warn(`Audit log cleanup skipped: ${(err as Error)?.message}`);
    }
  }

  /**
   * Writes an audit entry. Never throws — a logging failure must not be able
   * to break login, refresh, or logout for a user.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      const actor = await this.resolveActor(entry);
      const tenantId = entry.tenantId || actor.tenantId;
      const organizationName =
        entry.organizationName ||
        (tenantId ? await this.organizationName(tenantId) : undefined) ||
        actor.tenantName;

      await this.auditLogModel.create({
        action: entry.action,
        actorType: entry.actorType,
        userId: entry.userId,
        email: entry.email || actor.email,
        tenantId,
        ipAddress: entry.ipAddress || 'unknown',
        userAgent: entry.userAgent || 'unknown',
        reason: entry.reason,
        module: entry.module || 'Authentication',
        status: entry.status || statusForAction(entry.action),
        organizationName,
        organizationLogo: entry.organizationLogo,
        userName: entry.userName || actor.name,
        userRole: entry.userRole || actor.role,
        userAvatar: entry.userAvatar,
        actionDetails: entry.actionDetails,
        device: entry.device || describeUserAgent(entry.userAgent),
        changes: entry.changes,
        metadata: entry.metadata,
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log for action "${entry.action}": ${(err as Error)?.message}`,
      );
    }
  }

  /**
   * Who the entry is about, from the account itself — callers mostly know an
   * id or an email, and the trail should read "Ayesha Khan · Org Admin", not a
   * UUID. A failed sign-in for a real account is attributed to it too.
   */
  private async resolveActor(entry: AuditLogEntry): Promise<{
    name?: string;
    role?: string;
    email?: string;
    tenantId?: string;
    tenantName?: string;
  }> {
    try {
      if (entry.actorType === 'superadmin') {
        const admin =
          entry.userId && this.superAdminModel
            ? await this.superAdminModel.findByPk(entry.userId, {
                attributes: ['name', 'firstName', 'lastName', 'email'],
              })
            : entry.email && this.superAdminModel
              ? await this.superAdminModel.findOne({
                  where: { email: entry.email },
                  attributes: ['name', 'firstName', 'lastName', 'email'],
                })
              : null;
        return {
          name: fullName(admin),
          role: 'Super Admin',
          email: admin?.email,
        };
      }
      if (
        entry.actorType === 'tenant' &&
        this.credentialModel &&
        (entry.userId || entry.email)
      ) {
        const attributes = [
          'firstName',
          'lastName',
          'email',
          'role',
          'tenantId',
          'tenantName',
        ];
        const cred = entry.userId
          ? await this.credentialModel.findByPk(entry.userId, { attributes })
          : await this.credentialModel.findOne({
              where: { email: entry.email },
              attributes,
            });
        if (cred) {
          return {
            name: fullName(cred),
            role: roleLabel(cred.role),
            email: cred.email,
            tenantId: cred.tenantId,
            tenantName: cred.tenantName,
          };
        }
      }
    } catch (err) {
      this.logger.debug(
        `Audit actor lookup failed: ${(err as Error)?.message}`,
      );
    }
    return {};
  }

  /** The organization's current display name, cached for ten minutes. */
  private async organizationName(
    tenantId: string,
  ): Promise<string | undefined> {
    const cached = this.organizationNames.get(tenantId);
    if (cached && Date.now() - cached.at < 10 * 60_000)
      return cached.name ?? undefined;
    let name: string | null = null;
    try {
      const rows = await this.auditLogModel.sequelize!.query<{
        name: string | null;
      }>(
        'SELECT COALESCE(NULLIF("organizationName", \'\'), name) AS name FROM tenants WHERE id = :id LIMIT 1',
        { replacements: { id: tenantId }, type: QueryTypes.SELECT },
      );
      name = rows[0]?.name ?? null;
    } catch {
      // The tenants table lives in the shared platform database; if it can't be read, leave the name blank.
    }
    this.organizationNames.set(tenantId, { name, at: Date.now() });
    return name ?? undefined;
  }

  private buildWhere(filter: AuditLogQuery): WhereOptions {
    const and: WhereOptions[] = [{ action: { [Op.notIn]: NOISE_ACTIONS } }];

    if (filter.email) and.push({ email: filter.email });
    if (filter.action) and.push({ action: filter.action });
    if (filter.userId) and.push({ userId: filter.userId });
    if (filter.module) and.push({ module: filter.module });
    if (filter.status) and.push({ status: filter.status });
    if (filter.category === 'security') and.push(this.securityWhere());

    const tenantFilter = filter.tenantId || filter.organizationId;
    if (tenantFilter) and.push({ tenantId: tenantFilter });

    const range: Record<symbol, Date> = {};
    const from = filter.from ? new Date(filter.from) : null;
    const to = filter.to ? new Date(filter.to) : null;
    if (from && !Number.isNaN(from.getTime())) range[Op.gte] = from;
    if (to && !Number.isNaN(to.getTime())) range[Op.lte] = to;
    if (Object.getOwnPropertySymbols(range).length)
      and.push({ createdAt: range });

    if (filter.search && filter.search.trim()) {
      const term = `%${filter.search.trim()}%`;
      and.push({
        [Op.or]: [
          'organizationName',
          'userName',
          'email',
          'action',
          'actionDetails',
          'module',
          'ipAddress',
        ].map((field) => ({
          [field]: { [Op.iLike]: term },
        })),
      });
    }

    return { [Op.and]: and };
  }

  private securityWhere(): WhereOptions {
    return {
      [Op.or]: [
        { action: { [Op.in]: SECURITY_ACTIONS } },
        { module: SECURITY_MODULE },
      ],
    };
  }

  /** Queries audit logs with pagination, multi-field search, and filters. */
  async query(filter: AuditLogQuery) {
    const page = filter.page && filter.page > 0 ? Number(filter.page) : 1;
    const limit =
      filter.limit && filter.limit > 0 && filter.limit <= 100
        ? Number(filter.limit)
        : 25;

    const { count, rows } = await this.auditLogModel.findAndCountAll({
      where: this.buildWhere(filter),
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      data: rows,
    };
  }

  /** Single audit log with full details and field changes (for the Activity Details drawer). */
  async getById(id: string) {
    const log = await this.auditLogModel.findByPk(id);
    if (!log) {
      throw new NotFoundException('This activity record no longer exists.');
    }
    return log;
  }

  /**
   * Recent Activity feed for the System Management Overview tab. Projects the
   * audit trail into the compact "<description> · <relative time>" shape that
   * widget renders, rather than returning full audit rows.
   */
  async getRecentActivity(limit = 10) {
    const logs = await this.auditLogModel.findAll({
      where: { action: { [Op.notIn]: NOISE_ACTIONS } },
      order: [['createdAt', 'DESC']],
      limit,
    });

    return logs.map((log) => ({
      id: log.id,
      description: this.describeActivity(log),
      actor: log.userName || log.email || 'System',
      module: log.module,
      status: log.status,
      organizationName: log.organizationName || null,
      createdAt: log.createdAt,
      timeAgo: this.formatTimeAgo(log.createdAt),
    }));
  }

  /**
   * Turns an audit row into the readable sentence the feed shows. Falls back
   * to the raw action rather than inventing wording for events it doesn't
   * recognise.
   */
  private describeActivity(log: AuditLog): string {
    const actor = log.userName || log.email || 'System';
    const detail = log.actionDetails ? ` ${log.actionDetails}` : '';

    switch (log.action) {
      case 'LOGIN_SUCCESS':
        return `${actor} signed in`;
      case 'LOGIN_FAILED':
        return `Failed sign-in attempt for ${log.email || 'an unknown account'}`;
      case 'LOGOUT':
        return `${actor} signed out`;
      default: {
        const readable = log.action.replace(/_/g, ' ').toLowerCase();
        return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}${detail} by ${actor}`;
      }
    }
  }

  private formatTimeAgo(date: Date): string {
    const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  /**
   * The four KPI cards. Every figure is counted from the trail; a trend is 0
   * (and so hidden) when there's no earlier period to compare against.
   * "Today" is the platform's local day.
   */
  async getStats() {
    const now = new Date();
    const DAY = 24 * 60 * 60 * 1000;
    const startOfToday = localClock(
      now,
      utcOffsetMinutes(platformTimeZone(), now),
    ).dayStart;
    const startOfYesterday = new Date(startOfToday.getTime() - DAY);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * DAY);

    const count = (...conditions: WhereOptions[]) =>
      this.auditLogModel.count({
        where: {
          [Op.and]: [{ action: { [Op.notIn]: NOISE_ACTIONS } }, ...conditions],
        },
      });
    const since = (from: Date, to?: Date): WhereOptions => ({
      createdAt: to ? { [Op.gte]: from, [Op.lt]: to } : { [Op.gte]: from },
    });
    const failed: WhereOptions = { status: 'Failed' };

    const [
      total,
      today,
      yesterday,
      last30,
      prev30,
      failedLast30,
      failedPrev30,
      securityLast30,
      modules,
    ] = await Promise.all([
      count(),
      count(since(startOfToday)),
      count(since(startOfYesterday, startOfToday)),
      count(since(thirtyDaysAgo)),
      count(since(sixtyDaysAgo, thirtyDaysAgo)),
      count(failed, since(thirtyDaysAgo)),
      count(failed, since(sixtyDaysAgo, thirtyDaysAgo)),
      count(this.securityWhere(), since(thirtyDaysAgo)),
      this.auditLogModel.findAll({
        attributes: ['module'],
        where: {
          module: { [Op.ne]: null },
          action: { [Op.notIn]: NOISE_ACTIONS },
        },
        group: ['module'],
        raw: true,
      }),
    ]);

    const percentChange = (current: number, previous: number): number =>
      previous > 0
        ? Number((((current - previous) / previous) * 100).toFixed(1))
        : 0;
    const trend = (current: number, previous: number) => {
      const change = percentChange(current, previous);
      return {
        changePercentage: change,
        direction: change >= 0 ? 'up' : 'down',
      };
    };

    return {
      totalActivities: {
        count: total,
        period: 'last 30 days vs the 30 before',
        ...trend(last30, prev30),
      },
      todayActivity: {
        count: today,
        period: 'vs yesterday',
        ...trend(today, yesterday),
      },
      securityEvents: {
        count: securityLast30,
        status:
          securityLast30 > 0
            ? 'Last 30 days — review them'
            : 'None in the last 30 days',
        badge: securityLast30 > 0 ? 'warning' : 'success',
      },
      failedActions: {
        count: failedLast30,
        period: 'last 30 days vs the 30 before',
        ...trend(failedLast30, failedPrev30),
      },
      modules: (modules as unknown as { module: string }[])
        .map((m) => m.module)
        .filter(Boolean)
        .sort(),
    };
  }

  /**
   * Organization users' sign-ins in a window, per organization — for the
   * Reports page. Counted from the trail: successful sign-ins, failed ones,
   * how many different people signed in, and when the last one did.
   */
  async signInSummary(query: {
    from?: string;
    to?: string;
    tenantIds?: string[];
  }) {
    const from = query.from ? new Date(query.from) : new Date(0);
    const to = query.to ? new Date(query.to) : new Date();
    const tenantFilter = query.tenantIds?.length
      ? 'AND "tenantId" IN (:tenantIds)'
      : '';
    const rows = await this.auditLogModel.sequelize!.query<{
      tenantId: string;
      successful: string;
      failed: string;
      uniqueUsers: string;
      lastSignInAt: Date | null;
    }>(
      `SELECT "tenantId",
              COUNT(*) FILTER (WHERE action = 'LOGIN_SUCCESS') AS successful,
              COUNT(*) FILTER (WHERE action IN ('LOGIN_FAILED', 'TWO_FA_FAILED')) AS failed,
              COUNT(DISTINCT "userId") FILTER (WHERE action = 'LOGIN_SUCCESS') AS "uniqueUsers",
              MAX("createdAt") FILTER (WHERE action = 'LOGIN_SUCCESS') AS "lastSignInAt"
         FROM audit_logs
        WHERE "actorType" = 'tenant'
          AND "tenantId" IS NOT NULL
          AND action IN ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'TWO_FA_FAILED')
          AND "createdAt" >= :from AND "createdAt" <= :to
          ${tenantFilter}
        GROUP BY "tenantId"`,
      {
        replacements: { from, to, tenantIds: query.tenantIds ?? [] },
        type: QueryTypes.SELECT,
      },
    );
    const [totals] = await this.auditLogModel.sequelize!.query<{
      uniqueUsers: string;
      successful: string;
    }>(
      `SELECT COUNT(DISTINCT "userId") AS "uniqueUsers", COUNT(*) AS successful
         FROM audit_logs
        WHERE "actorType" = 'tenant' AND action = 'LOGIN_SUCCESS'
          AND "createdAt" >= :from AND "createdAt" <= :to`,
      { replacements: { from, to }, type: QueryTypes.SELECT },
    );

    return {
      byTenant: Object.fromEntries(
        rows.map((r) => [
          r.tenantId,
          {
            successful: Number(r.successful),
            failed: Number(r.failed),
            uniqueUsers: Number(r.uniqueUsers),
            lastSignInAt: r.lastSignInAt,
          },
        ]),
      ),
      totals: {
        uniqueUsers: Number(totals?.uniqueUsers ?? 0),
        successful: Number(totals?.successful ?? 0),
      },
    };
  }

  /** Plain rows for a report (security events and the like), newest first. */
  async reportRows(filter: AuditLogQuery & { maxRows?: number }) {
    const rows = await this.auditLogModel.findAll({
      where: this.buildWhere(filter),
      order: [['createdAt', 'DESC']],
      limit: Math.min(
        Math.max(Number(filter.maxRows) || 5000, 1),
        AUDIT_EXPORT_LIMIT,
      ),
      attributes: [
        'id',
        'createdAt',
        'action',
        'module',
        'status',
        'reason',
        'organizationName',
        'userName',
        'email',
        'userRole',
        'ipAddress',
        'device',
        'actionDetails',
      ],
      raw: true,
    });
    return rows;
  }

  /** Every entry matching the filters (up to AUDIT_EXPORT_LIMIT), as CSV. */
  async exportLogs(filter: AuditLogQuery) {
    const where = this.buildWhere(filter);
    const [total, logs] = await Promise.all([
      this.auditLogModel.count({ where }),
      this.auditLogModel.findAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: AUDIT_EXPORT_LIMIT,
      }),
    ]);

    const headers = [
      'Date & Time (UTC)',
      'Organization',
      'User',
      'Email',
      'Role',
      'Action',
      'Details',
      'Module',
      'Status',
      'Reason',
      'IP Address',
      'Device',
      'Changes',
      'Log ID',
    ];

    // A leading = + - @ would be run as a formula by Excel/Sheets.
    const escapeCsv = (val: unknown) => {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
      return `"${str.replace(/"/g, '""')}"`;
    };
    const describeChanges = (changes: unknown) =>
      Array.isArray(changes)
        ? changes
            .map((c: any) =>
              c?.before === undefined || c?.before === null
                ? `${c?.field}: ${c?.after}`
                : `${c?.field}: ${c?.before} → ${c?.after}`,
            )
            .join('; ')
        : '';

    const csvRows = [
      headers.join(','),
      ...logs.map((log) =>
        [
          log.createdAt
            ? new Date(log.createdAt)
                .toISOString()
                .replace('T', ' ')
                .slice(0, 19)
            : '',
          log.organizationName || 'Platform',
          log.userName || log.email || 'System',
          log.email || '',
          log.userRole || '',
          log.action,
          log.actionDetails || '',
          log.module || '',
          log.status || '',
          (log as any).reason || '',
          log.ipAddress || '',
          log.device || '',
          describeChanges(log.changes),
          log.id,
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ];

    return {
      contentType: 'text/csv',
      filename: `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`,
      // BOM so Excel reads names with accents correctly.
      csv: `﻿${csvRows.join('\n')}`,
      totalExported: logs.length,
      totalMatching: total,
    };
  }
}
