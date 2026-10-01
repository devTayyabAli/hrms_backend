import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { parseUserAgent } from '@app/common';
import { AuditLog } from '../models';

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
  changes?: Array<{ field: string; before: any; after: any }> | Record<string, any>;
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
  tenantId?: string;
  organizationId?: string;
  from?: string | Date;
  to?: string | Date;
  page?: number;
  limit?: number;
  format?: 'csv' | 'json';
}

/** Failure actions are named for it (`LOGIN_FAILED`), so the action is the only signal available. */
const statusForAction = (action: string): string =>
  /FAIL|DENIED|ERROR|INVALID/i.test(action) ? 'Failed' : 'Active';

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

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private seeded = false;

  constructor(@InjectModel(AuditLog) private readonly auditLogModel: typeof AuditLog) { }

  /**
   * Writes an audit entry. Never throws — a logging failure must not be able
   * to break login, refresh, or logout for a user.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.auditLogModel.create({
        action: entry.action,
        actorType: entry.actorType,
        userId: entry.userId,
        email: entry.email,
        tenantId: entry.tenantId,
        ipAddress: entry.ipAddress || 'unknown',
        userAgent: entry.userAgent || 'unknown',
        reason: entry.reason,
        module: entry.module || 'Authentication',
        // No caller passes a status, so defaulting flatly to 'Active' filed
        // every LOGIN_FAILED as a success and left the Failed Actions KPI —
        // which counts `status: 'Failed'` — unable to ever match one.
        status: entry.status || statusForAction(entry.action),
        organizationName: entry.organizationName,
        organizationLogo: entry.organizationLogo,
        userName: entry.userName,
        userRole: entry.userRole,
        userAvatar: entry.userAvatar,
        actionDetails: entry.actionDetails,
        // Auth callers pass a raw user agent and no device, which the activity
        // drawer then had to render as a full `Mozilla/5.0 (…)` string.
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
   * Queries audit logs with pagination, multi-field search, and module/status filters.
   */
  async query(filter: AuditLogQuery) {
    await this.ensureSeedLogs();

    const page = filter.page && filter.page > 0 ? Number(filter.page) : 1;
    const limit = filter.limit && filter.limit > 0 && filter.limit <= 100 ? Number(filter.limit) : 25;

    const where: Record<string | symbol, any> = {};

    if (filter.email) where.email = filter.email;
    if (filter.action) where.action = filter.action;
    if (filter.userId) where.userId = filter.userId;
    if (filter.module) where.module = filter.module;
    if (filter.status) where.status = filter.status;

    const tenantFilter = filter.tenantId || filter.organizationId;
    if (tenantFilter) where.tenantId = tenantFilter;

    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt[Op.gte] = new Date(filter.from);
      if (filter.to) where.createdAt[Op.lte] = new Date(filter.to);
    }

    if (filter.search && filter.search.trim()) {
      const term = `%${filter.search.trim()}%`;
      const searchOp = (Op as any).iLike || Op.like;
      where[Op.or] = [
        { organizationName: { [searchOp]: term } },
        { userName: { [searchOp]: term } },
        { email: { [searchOp]: term } },
        { action: { [searchOp]: term } },
        { actionDetails: { [searchOp]: term } },
        { module: { [searchOp]: term } },
        { ipAddress: { [searchOp]: term } },
      ];
    }

    const { count, rows } = await this.auditLogModel.findAndCountAll({
      where,
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

  /**
   * Get single audit log with full details and field changes (for Activity Details drawer).
   */
  async getById(id: string) {
    await this.ensureSeedLogs();

    const log = await this.auditLogModel.findByPk(id);
    if (!log) {
      throw new NotFoundException(`Audit log with ID ${id} not found`);
    }
    return log;
  }

  /**
   * Recent Activity feed for the System Management Overview tab. Projects the
   * audit trail into the compact "<description> · <relative time>" shape that
   * widget renders, rather than returning full audit rows.
   */
  async getRecentActivity(limit = 10) {
    await this.ensureSeedLogs();

    const logs = await this.auditLogModel.findAll({
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
   * Turns an audit row into the readable sentence the feed shows, e.g.
   * `New Organization "pepsiCo" registered by System`. Falls back to the raw
   * action rather than inventing wording for events it doesn't recognise.
   */
  private describeActivity(log: AuditLog): string {
    const actor = log.userName || log.email || 'System';
    const subject = log.organizationName ? `"${log.organizationName}"` : '';

    switch (log.action) {
      case 'ORGANIZATION_CREATED':
        return `New Organization ${subject} registered by ${actor}`.replace(/\s+/g, ' ').trim();
      case 'SUBSCRIPTION_UPDATED':
        return `Subscription plan ${log.actionDetails ? `"${log.actionDetails}"` : ''} updated by ${actor}`
          .replace(/\s+/g, ' ')
          .trim();
      case 'BACKUP_COMPLETED':
        return `System backup completed successfully by ${actor}`;
      case 'LOGIN_SUCCESS':
        return `${actor} signed in`;
      case 'LOGIN_FAILED':
        return `Failed sign-in attempt for ${log.email || 'unknown account'}`;
      default: {
        const readable = log.action.replace(/_/g, ' ').toLowerCase();
        return `${readable.charAt(0).toUpperCase()}${readable.slice(1)} by ${actor}`;
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
   * Get KPI statistics for top cards:
   * - Total Activities (+8.2% vs last 30 days)
   * - Today's Activity (+1.1% vs yesterday)
   * - Security Events (Requires review)
   * - Failed Actions (-3.2% vs last 30 days)
   */
  async getStats() {
    await this.ensureSeedLogs();

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const [
      totalCount,
      todayCount,
      yesterdayCount,
      last30Count,
      prev30Count,
      failedCount,
      failedLast30,
      failedPrev30,
      securityCount,
    ] = await Promise.all([
      this.auditLogModel.count(),
      this.auditLogModel.count({
        where: { createdAt: { [Op.gte]: startOfToday } },
      }),
      this.auditLogModel.count({
        where: {
          createdAt: {
            [Op.gte]: startOfYesterday,
            [Op.lt]: startOfToday,
          },
        },
      }),
      this.auditLogModel.count({
        where: { createdAt: { [Op.gte]: thirtyDaysAgo } },
      }),
      this.auditLogModel.count({
        where: {
          createdAt: {
            [Op.gte]: sixtyDaysAgo,
            [Op.lt]: thirtyDaysAgo,
          },
        },
      }),
      this.auditLogModel.count({ where: { status: 'Failed' } }),
      this.auditLogModel.count({
        where: { status: 'Failed', createdAt: { [Op.gte]: thirtyDaysAgo } },
      }),
      this.auditLogModel.count({
        where: {
          status: 'Failed',
          createdAt: { [Op.gte]: sixtyDaysAgo, [Op.lt]: thirtyDaysAgo },
        },
      }),
      this.auditLogModel.count({
        where: {
          [Op.or]: [
            { module: 'Authentication' },
            { action: { [(Op as any).iLike || Op.like]: '%login%' } },
            { action: { [(Op as any).iLike || Op.like]: '%permission%' } },
            { status: 'Failed' },
          ],
        },
      }),
    ]);

    // A period with nothing before it has no movement to report. Reporting 0
    // lets the caller omit the trend line rather than print an invented one.
    const percentChange = (current: number, previous: number): number =>
      previous > 0
        ? Number((((current - previous) / previous) * 100).toFixed(1))
        : 0;

    const totalTrend = percentChange(last30Count, prev30Count);
    const todayTrend = percentChange(todayCount, yesterdayCount);
    const failedTrend = percentChange(failedLast30, failedPrev30);

    return {
      totalActivities: {
        count: totalCount,
        changePercentage: totalTrend,
        period: 'vs last 30 days',
        direction: totalTrend >= 0 ? 'up' : 'down',
      },
      todayActivity: {
        count: todayCount,
        changePercentage: todayTrend,
        period: 'vs yesterday',
        direction: todayTrend >= 0 ? 'up' : 'down',
      },
      securityEvents: {
        count: securityCount,
        status: 'Requires review',
        badge: 'warning',
      },
      failedActions: {
        count: failedCount,
        changePercentage: failedTrend,
        period: 'vs last 30 days',
        direction: failedTrend > 0 ? 'up' : 'down',
      },
    };
  }

  /**
   * Exports filtered audit logs into CSV format.
   */
  async exportLogs(filter: AuditLogQuery) {
    await this.ensureSeedLogs();

    // Query up to 1000 items for export
    const exportFilter = { ...filter, page: 1, limit: 1000 };
    const result = await this.query(exportFilter);
    const logs = result.data;

    const headers = [
      'Log ID',
      'Date & Time',
      'Organization',
      'User',
      'User Role',
      'Action',
      'Details',
      'Module',
      'Status',
      'IP Address',
      'Device',
      'Changes Count',
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = [
      headers.join(','),
      ...logs.map((log: any) => {
        const changesCount = Array.isArray(log.changes) ? log.changes.length : log.changes ? 1 : 0;
        return [
          escapeCsv(log.id),
          escapeCsv(log.createdAt ? new Date(log.createdAt).toISOString() : ''),
          escapeCsv(log.organizationName || 'Platform'),
          escapeCsv(log.userName || log.email || 'System'),
          escapeCsv(log.userRole || log.actorType || 'User'),
          escapeCsv(log.action),
          escapeCsv(log.actionDetails || ''),
          escapeCsv(log.module || 'General'),
          escapeCsv(log.status || 'Active'),
          escapeCsv(log.ipAddress || ''),
          escapeCsv(log.device || log.userAgent || ''),
          escapeCsv(changesCount),
        ].join(',');
      }),
    ];

    return {
      contentType: 'text/csv',
      filename: `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: csvRows.join('\n'),
      totalExported: logs.length,
    };
  }

  /**
   * Ensures realistic baseline audit logs matching the UI screen exist in the database.
   */
  private async ensureSeedLogs(): Promise<void> {
    if (this.seeded) return;

    try {
      const count = await this.auditLogModel.count();
      if (count >= 6) {
        this.seeded = true;
        return;
      }

      const seedEntries: AuditLogEntry[] = [
        {
          action: 'Changed role permissions',
          actionDetails: 'HR Manager',
          module: 'Roles & Permissions',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'Oppo',
          organizationLogo: 'https://images.unsplash.com/photo-1616469829941-c7200edec809?w=80',
          userName: 'David Lee',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          device: 'Chrome 124 on macOS',
          changes: [
            { field: 'Employee - View', before: 'Denied', after: 'Granted' },
            { field: 'Leave - View', before: 'Denied', after: 'Granted' },
            { field: 'Leave - Create', before: 'Denied', after: 'Granted' },
            { field: 'Attendance - View', before: 'Granted', after: 'Granted' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
        {
          action: 'Updated subscription plan',
          actionDetails: 'Enterprise -> Professional',
          module: 'Subscriptions',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'Coca-Cola',
          organizationLogo: 'https://images.unsplash.com/photo-1554866585-cd94860890b7?w=80',
          userName: 'John Smith',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          device: 'Chrome 124 on Windows',
          changes: [
            { field: 'Plan Tier', before: 'Enterprise ($1,499/mo)', after: 'Professional ($799/mo)' },
            { field: 'User Limit', before: 'Unlimited', after: 'Up to 250 users' },
            { field: 'Dedicated Account Manager', before: 'Enabled', after: 'Disabled' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
        {
          action: 'Created HR user',
          actionDetails: 'Ayesha Fatima',
          module: 'Users',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'Haier',
          organizationLogo: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=80',
          userName: 'Emily Johnson',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
          device: 'Safari 17 on macOS',
          changes: [
            { field: 'Account Status', before: 'None', after: 'Invited' },
            { field: 'Assigned Role', before: 'None', after: 'HR Specialist' },
            { field: 'Department', before: 'None', after: 'People Operations' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
        {
          action: 'Failed login attempt',
          actionDetails: 'Invalid credentials (3rd attempt)',
          module: 'Authentication',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'Vivo',
          organizationLogo: 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=80',
          userName: 'Sophia Wang',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          device: 'Edge 123 on Windows',
          reason: 'Invalid password provided',
          changes: [
            { field: 'Failed Attempts', before: '2', after: '3' },
            { field: 'Security Alert', before: 'Normal', after: 'Requires review' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
        {
          action: 'Exported report',
          actionDetails: 'Employee Summary Report',
          module: 'Reports',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'Unilever',
          organizationLogo: 'https://images.unsplash.com/photo-1560179707-f14e90ef3623?w=80',
          userName: 'Micheal Brown',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          device: 'Chrome 124 on Linux',
          changes: [
            { field: 'Report Export', before: 'Draft', after: 'Generated' },
            { field: 'Total Records', before: '0', after: '450 Employees' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
        {
          action: 'Updated subscription plan',
          actionDetails: 'Enterprise -> Professional',
          module: 'Subscriptions',
          status: 'Active',
          actorType: 'tenant',
          organizationName: 'PixelCraft',
          organizationLogo: 'https://images.unsplash.com/photo-1572021335469-31706a17aaef?w=80',
          userName: 'Sara David',
          userRole: 'Organization Admin',
          userAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100',
          ipAddress: '103.21.244.12',
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
          device: 'Firefox 125 on macOS',
          changes: [
            { field: 'Plan Tier', before: 'Enterprise ($1,499/mo)', after: 'Professional ($799/mo)' },
            { field: 'Billing Cycle', before: 'Monthly', after: 'Annual' },
          ],
          createdAt: new Date('2026-08-18T10:42:00.000Z'),
        },
      ];

      for (const entry of seedEntries) {
        await this.auditLogModel.create({
          action: entry.action,
          actorType: entry.actorType,
          userId: entry.userId,
          email: entry.email,
          tenantId: entry.tenantId,
          ipAddress: entry.ipAddress || 'unknown',
          userAgent: entry.userAgent || 'unknown',
          reason: entry.reason,
          module: entry.module,
          status: entry.status,
          organizationName: entry.organizationName,
          organizationLogo: entry.organizationLogo,
          userName: entry.userName,
          userRole: entry.userRole,
          userAvatar: entry.userAvatar,
          actionDetails: entry.actionDetails,
          device: entry.device,
          changes: entry.changes,
          metadata: entry.metadata,
          createdAt: entry.createdAt,
        });
      }

      this.logger.log('Initial sample audit logs seeded successfully.');
      this.seeded = true;
    } catch (err) {
      this.logger.warn(`Could not seed initial audit logs: ${(err as Error)?.message}`);
    }
  }
}
