import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { Op, QueryTypes, fn, col, literal, where } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  DEFAULT_PLATFORM_TIME_ZONE,
  GenerateReportDto,
  CustomReportQueryDto,
  CreateCustomReportDto,
  UpdateCustomReportDto,
  PlatformGrowthQueryDto,
  TopOrganizationsQueryDto,
  ReportFiltersDto,
  utcOffsetMinutes,
} from '@app/common';
import {
  DirectoryRoleCategory,
  PlatformDirectoryPerson,
  PlatformTenantCounters,
} from '@app/database';
import { Tenant, Subscription, Plan, CustomReport, ReportRun } from '../models';
import { PlatformOrganizationsService } from './platform-organizations.service';
import { PlatformStatusService } from './platform-status.service';
import {
  REPORT_CATALOG,
  ReportColumn,
  ReportDefinition,
  ResolvedPeriod,
  monthsBetween,
  reportDefinition,
  resolvePeriod,
  selectColumns,
} from './report-catalog';

/** Who asked for a report or saved one. */
export interface ReportActor {
  id?: string | null;
  email?: string | null;
}

type Row = Record<string, unknown>;

/** Rows returned in the on-screen preview; the CSV always has all of them. */
const PREVIEW_ROWS = 100;
/** CSVs above this aren't kept for re-download (they can be generated again). */
const MAX_STORED_CSV = 5 * 1024 * 1024;

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  TRIAL: 'Trial',
  PENDING: 'Pending',
  DEACTIVATED: 'Deactivated',
  PENDING_PAYMENT: 'Pending payment',
  PAST_DUE: 'Past due',
  SUSPENDED: 'Suspended',
  CANCELLED: 'Cancelled',
  MONTHLY: 'Monthly',
  ANNUALLY: 'Yearly',
};
const label = (value: unknown) =>
  typeof value === 'string' ? (STATUS_LABELS[value] ?? value) : value;

/** Event names in the security report. */
const EVENT_LABELS: Record<string, string> = {
  LOGIN_FAILED: 'Failed sign-in',
  TWO_FA_FAILED: 'Wrong 2FA code',
  TOKEN_REFRESH_FAILED: 'Session renewal refused',
  ACCOUNT_LOCKED: 'Account locked',
};
const humanizeAction = (action: string) =>
  EVENT_LABELS[action] ??
  action
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ')
    .replace(/\b2fa\b/i, '2FA')
    .replace(/\bip\b/i, 'IP');

/**
 * The six sample custom reports this service used to insert so the table
 * wasn't empty. Removed on startup; matched on name and the exact invented
 * "last generated" time together, which nothing real can share.
 */
const SAMPLE_REPORTS: [string, string][] = [
  ['Employee Activity Report', '2026-08-18T10:24:00.000Z'],
  ['Organization Summary', '2026-08-15T16:12:00.000Z'],
  ['Payroll Report', '2026-08-12T14:45:00.000Z'],
  ['Subscription Report', '2026-08-10T09:30:00.000Z'],
  ['Performance Report', '2026-08-08T11:20:00.000Z'],
  ['User Login Report', '2026-08-05T18:24:00.000Z'],
];

const platformTimeZone = () =>
  process.env.NOTIFICATIONS_DEFAULT_TIME_ZONE || DEFAULT_PLATFORM_TIME_ZONE;

/** When a person joined their organization; rows synced before that was recorded fall back to the sync time. */
const PEOPLE_DATE = 'COALESCE("sourceCreatedAt", "createdAt")';

@Injectable()
export class PlatformReportsService implements OnModuleInit {
  private readonly logger = new Logger(PlatformReportsService.name);

  constructor(
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(CustomReport)
    private readonly customReportModel: typeof CustomReport,
    @InjectModel(ReportRun) private readonly runModel: typeof ReportRun,
    @InjectModel(PlatformDirectoryPerson)
    private readonly directory: typeof PlatformDirectoryPerson,
    @InjectModel(PlatformTenantCounters)
    private readonly counters: typeof PlatformTenantCounters,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly organizations: PlatformOrganizationsService,
    private readonly platformStatus: PlatformStatusService,
  ) {}

  async onModuleInit() {
    try {
      const removed = await this.customReportModel.destroy({
        where: {
          [Op.or]: SAMPLE_REPORTS.map(([name, at]) => ({
            name,
            lastGeneratedAt: new Date(at),
          })),
        },
      });
      if (removed)
        this.logger.log(
          `Removed ${removed} sample custom reports that were never created by anyone.`,
        );
    } catch (err) {
      this.logger.warn(
        `Custom report cleanup skipped: ${(err as Error)?.message}`,
      );
    }
  }

  private offset(at = new Date()) {
    return utcOffsetMinutes(platformTimeZone(), at);
  }

  // ==========================================
  // Page data: KPI cards, growth chart, top organizations
  // ==========================================

  /**
   * The four KPI cards. Growth is this month against the end of last month
   * (or the last 30 days against the 30 before, for sign-ins); 0 means there
   * was nothing to compare with, and the page hides the arrow.
   */
  async getStats() {
    const now = new Date();
    const offset = this.offset(now);
    const monthStart = resolvePeriod(
      { period: 'this-month' },
      'this-month',
      now,
      offset,
    ).from!;
    const lastMonth = resolvePeriod(
      { period: 'last-month' },
      'last-month',
      now,
      offset,
    );
    const DAY = 24 * 60 * 60 * 1000;

    const peopleWhere = { deletedAt: null };
    const [
      orgs,
      orgsBefore,
      people,
      peopleBefore,
      runsThisMonth,
      runsLastMonth,
      runsTotal,
      signIns,
      signInsBefore,
    ] = await Promise.all([
      this.tenantModel.count(),
      this.tenantModel.count({ where: { createdAt: { [Op.lt]: monthStart } } }),
      this.directory.count({ where: peopleWhere }),
      this.directory.count({
        where: {
          ...peopleWhere,
          [Op.and]: [where(literal(PEOPLE_DATE), Op.lt, monthStart)],
        },
      }),
      this.runModel.count({ where: { createdAt: { [Op.gte]: monthStart } } }),
      this.runModel.count({
        where: {
          createdAt: { [Op.gte]: lastMonth.from!, [Op.lte]: lastMonth.to },
        },
      }),
      this.runModel.count(),
      this.signInSummary(new Date(now.getTime() - 30 * DAY), now),
      this.signInSummary(
        new Date(now.getTime() - 60 * DAY),
        new Date(now.getTime() - 30 * DAY),
      ),
    ]);

    const change = (current: number, previous: number) =>
      previous > 0
        ? Number((((current - previous) / previous) * 100).toFixed(1))
        : 0;
    const trend = (current: number, previous: number, period: string) => {
      const pct = change(current, previous);
      return {
        changePercentage: pct,
        direction: pct >= 0 ? 'up' : 'down',
        period,
      };
    };

    return {
      totalOrganizations: {
        count: orgs,
        ...trend(orgs, orgsBefore, 'vs end of last month'),
      },
      totalUsers: {
        count: people,
        ...trend(people, peopleBefore, 'vs end of last month'),
      },
      activeUsers: {
        count: signIns?.totals.uniqueUsers ?? null,
        ...trend(
          signIns?.totals.uniqueUsers ?? 0,
          signInsBefore?.totals.uniqueUsers ?? 0,
          'signed in, last 30 days vs the 30 before',
        ),
      },
      reportsGenerated: {
        count: runsTotal,
        ...trend(runsThisMonth, runsLastMonth, 'this month vs last month'),
      },
    };
  }

  /**
   * Cumulative organizations, people and report runs at the end of each month.
   * People are dated by when they were added in their organization.
   */
  async getPlatformGrowth(query?: PlatformGrowthQueryDto) {
    const now = new Date();
    const offset = this.offset(now);
    const monthsCount = query?.period === '12months' ? 12 : 6;
    const range = resolvePeriod(
      { period: 'last-12-months' },
      'last-12-months',
      now,
      offset,
    );
    const months = monthsBetween(range.from!, now, offset).slice(-monthsCount);

    const [orgs, people, runs] = await Promise.all([
      this.cumulativeBy(this.tenantModel, '"createdAt"', months),
      this.cumulativeBy(this.directory, PEOPLE_DATE, months, {
        deletedAt: null,
      }),
      this.cumulativeBy(this.runModel, '"createdAt"', months),
    ]);

    return {
      period: monthsCount === 12 ? '12months' : '6months',
      months: months.map((m) => m.label.split(' ')[0]),
      series: [
        { name: 'Organizations', color: '#3B82F6', data: orgs },
        { name: 'Users', color: '#10B981', data: people },
        { name: 'Reports', color: '#8B5CF6', data: runs },
      ],
    };
  }

  /**
   * Running totals at each month end: one query grouped by local month, then
   * everything before the first month plus each month in turn.
   * `dateExpr` is a fixed column expression from this file, never input.
   */
  private async cumulativeBy(
    model: any,
    dateExpr: string,
    months: { key: string; end: Date }[],
    where: Row = {},
  ) {
    if (!months.length) return [];
    const perMonth = await this.groupByMonth(
      model,
      this.monthBucket(dateExpr),
      where,
    );
    const firstKey = months[0].key;
    let running = 0;
    for (const [key, total] of perMonth) if (key < firstKey) running += total;
    return months.map((m) => {
      running += perMonth.get(m.key) ?? 0;
      return running;
    });
  }

  /** "YYYY-MM" of a timestamp column in the platform's time zone. */
  private monthBucket(dateExpr: string) {
    return `to_char(${dateExpr} + interval '${Math.trunc(this.offset())} minutes', 'YYYY-MM')`;
  }

  /** Organizations ranked by headcount (from the directory, no tenant database is opened). */
  async getTopOrganizations(query?: TopOrganizationsQueryDto) {
    const limit = Math.min(Math.max(Number(query?.limit) || 5, 1), 50);
    const orgs = await this.organizationRows();
    return orgs
      .sort(
        (a, b) =>
          b.people - a.people ||
          String(a.organization).localeCompare(String(b.organization)),
      )
      .slice(0, limit)
      .map((o) => ({
        id: o.id,
        name: o.organization,
        domain: o.domain,
        logo: o.logoUrl,
        employeesCount: o.people,
        status: label(o.status),
        plan: o.plan,
      }));
  }

  // ==========================================
  // Report catalog and generation
  // ==========================================

  getPopularTemplates() {
    return Object.values(REPORT_CATALOG).map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      category: d.category,
      periodApplies: d.periodApplies,
      defaultPeriod: d.defaultPeriod,
      statusFilter: d.statusFilter ?? null,
      columns: d.columns,
    }));
  }

  /**
   * Runs a report against live data, stores the run (with its CSV, so the
   * download matches what was previewed) and returns the preview.
   */
  async generateReport(
    dto: GenerateReportDto & { customReportId?: string | null; title?: string },
    actor?: ReportActor,
  ) {
    const definition = reportDefinition(dto.reportType);
    const columns = selectColumns(definition, dto.columns);
    const started = Date.now();
    const now = new Date();
    const offset = this.offset(now);
    const period = resolvePeriod(
      dto.filters,
      definition.defaultPeriod,
      now,
      offset,
    );
    const status =
      dto.filters?.status &&
      definition.statusFilter?.options.some(
        (o) => o.value === dto.filters!.status,
      )
        ? dto.filters.status
        : undefined;

    const { rows, summary } = await this.buildRows(
      definition,
      period,
      status,
      offset,
    );
    const csv = this.toCsv(columns, rows, offset);
    const durationMs = Date.now() - started;
    const title = dto.title || definition.title;
    const generatedByName = await this.actorName(actor);

    const run = await this.runModel.create({
      reportType: definition.id,
      customReportId: dto.customReportId ?? null,
      title,
      filters: {
        period: period.period,
        from: dto.filters?.from ?? null,
        to: dto.filters?.to ?? null,
        status: status ?? null,
        columns: dto.columns ?? null,
      },
      rowCount: rows.length,
      durationMs,
      generatedById: actor?.id ?? null,
      generatedByName,
      content: Buffer.byteLength(csv) <= MAX_STORED_CSV ? csv : null,
    });

    if (dto.customReportId) {
      await this.customReportModel.update(
        { lastGeneratedAt: now },
        { where: { id: dto.customReportId } },
      );
    }

    return {
      runId: run.id,
      reportType: definition.id,
      title,
      category: definition.category,
      generatedAt: run.createdAt,
      generatedBy: generatedByName,
      durationMs,
      period: {
        value: period.period,
        label: period.label,
        from: period.from,
        to: period.to,
        appliesTo: definition.periodApplies,
      },
      status: status
        ? {
            value: status,
            label: definition.statusFilter!.options.find(
              (o) => o.value === status,
            )!.label,
          }
        : null,
      timeZone: platformTimeZone(),
      columns,
      rows: rows
        .slice(0, PREVIEW_ROWS)
        .map((row) =>
          Object.fromEntries(columns.map((c) => [c.key, row[c.key] ?? null])),
        ),
      totalRows: rows.length,
      summary,
      downloadable: run.content !== null,
    };
  }

  /** The CSV a run produced, for download. */
  async getRunFile(id: string) {
    const run = await this.runModel.findByPk(id);
    if (!run) throw new NotFoundException('This report run no longer exists.');
    if (run.content === null)
      throw new BadRequestException(
        'This report was too large to keep. Generate it again to download it.',
      );
    return this.toFile(run);
  }

  /** The CSV of a custom report's most recent run. */
  async getLastRunFile(customReportId: string) {
    const run = await this.runModel.findOne({
      where: { customReportId },
      order: [['createdAt', 'DESC']],
    });
    if (!run)
      throw new NotFoundException(
        'This report hasn’t been run yet. Run it first.',
      );
    if (run.content === null)
      throw new BadRequestException(
        'The last run was too large to keep. Run the report again.',
      );
    return this.toFile(run);
  }

  private toFile(run: ReportRun) {
    const stamp = new Date(run.createdAt).toISOString().slice(0, 10);
    const slug =
      run.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'report';
    return {
      filename: `${slug}-${stamp}.csv`,
      contentType: 'text/csv; charset=utf-8',
      csv: run.content,
      title: run.title,
    };
  }

  private async buildRows(
    definition: ReportDefinition,
    period: ResolvedPeriod,
    status: string | undefined,
    offset: number,
  ): Promise<{
    rows: Row[];
    summary: { label: string; value: string | number }[];
  }> {
    const inPeriod = (date: Date | null | undefined) =>
      !!date &&
      (!period.from || new Date(date) >= period.from) &&
      new Date(date) <= period.to;

    switch (definition.id) {
      case 'organization-summary': {
        const rows = (await this.organizationRows()).filter(
          (o) =>
            (!status || o.status === status) &&
            (period.period === 'all-time' || inPeriod(o.createdAt)),
        );
        return {
          rows: rows.map((o) => ({
            ...o,
            status: label(o.status),
            subscriptionStatus: label(o.subscriptionStatus),
            billingCycle: label(o.billingCycle),
          })),
          summary: [
            { label: 'Organizations', value: rows.length },
            {
              label: 'Active',
              value: rows.filter((o) => o.status === 'ACTIVE').length,
            },
            { label: 'People', value: rows.reduce((s, o) => s + o.people, 0) },
          ],
        };
      }

      case 'user-activity':
      case 'system-usage': {
        const orgs = (await this.organizationRows()).filter(
          (o) => !status || o.status === status,
        );
        const signIns = await this.signInSummary(
          period.from ?? new Date(0),
          period.to,
          orgs.map((o) => o.id),
        );
        if (!signIns)
          throw new BadRequestException(
            'Sign-in data is unavailable right now (the authentication service did not answer). Try again in a moment.',
          );
        const sizes =
          definition.id === 'system-usage'
            ? await this.platformStatus.measureDatabases()
            : null;
        const rows = orgs.map((o) => {
          const s = signIns.byTenant[o.id];
          return {
            organization: o.organization,
            status: label(o.status),
            people: o.people,
            activePeople: o.activePeople,
            usersSignedIn: s?.uniqueUsers ?? 0,
            signIns: s?.successful ?? 0,
            failedSignIns: s?.failed ?? 0,
            lastSignInAt: s?.lastSignInAt ?? null,
            databaseSize: sizes
              ? (sizes.byTenant.get(o.id) ?? null)
              : undefined,
          };
        });
        const summary: { label: string; value: string | number }[] =
          definition.id === 'user-activity'
            ? [
                { label: 'Organizations', value: rows.length },
                {
                  label: 'Sign-ins',
                  value: rows.reduce((s, r) => s + r.signIns, 0),
                },
                {
                  label: 'Failed sign-ins',
                  value: rows.reduce((s, r) => s + r.failedSignIns, 0),
                },
                {
                  label: 'People who signed in',
                  value: rows.reduce((s, r) => s + r.usersSignedIn, 0),
                },
              ]
            : [
                { label: 'Organizations', value: rows.length },
                {
                  label: 'Organization databases',
                  value: formatBytes(
                    rows.reduce((s, r) => s + (r.databaseSize ?? 0), 0),
                  ),
                },
                {
                  label: 'Platform database',
                  value: formatBytes(sizes?.platformBytes ?? 0),
                },
                ...(sizes?.unmeasuredDatabases
                  ? [
                      {
                        label: 'Not measured',
                        value: sizes.unmeasuredDatabases,
                      },
                    ]
                  : []),
              ];
        return {
          rows:
            definition.id === 'system-usage'
              ? rows.sort(
                  (a, b) => (b.databaseSize ?? 0) - (a.databaseSize ?? 0),
                )
              : rows.sort((a, b) => b.signIns - a.signIns),
          summary,
        };
      }

      case 'subscription-reports': {
        const where: Row = {};
        if (status) where.status = status;
        if (period.from)
          where.startDate = { [Op.gte]: period.from, [Op.lte]: period.to };
        const subs = await this.subscriptionModel.findAll({
          where,
          include: [
            { model: Plan, attributes: ['name'] },
            { model: Tenant, attributes: ['name', 'organizationName'] },
          ],
          order: [['startDate', 'DESC']],
        });
        const rows = subs.map((s) => ({
          organization: s.tenant?.organizationName || s.tenant?.name || '—',
          plan: s.plan?.name ?? '—',
          status: label(s.status),
          billingCycle: label(s.billingCycle),
          price:
            s.billingCycle === 'ANNUALLY'
              ? Number(s.snapshotYearlyPrice ?? 0)
              : Number(s.snapshotMonthlyPrice ?? 0),
          startDate: s.startDate,
          nextBillingDate: s.nextBillingDate,
          pastDueAt: s.pastDueAt,
          gracePeriodEndsAt: s.gracePeriodEndsAt,
          cancelledAt: s.cancelledAt,
          cancellationReason: s.cancellationReason,
        }));
        const monthly = subs
          .filter((s) => s.status === 'ACTIVE')
          .reduce(
            (sum, s) =>
              sum +
              (s.billingCycle === 'ANNUALLY'
                ? Number(s.snapshotYearlyPrice ?? 0) / 12
                : Number(s.snapshotMonthlyPrice ?? 0)),
            0,
          );
        return {
          rows,
          summary: [
            { label: 'Subscriptions', value: rows.length },
            {
              label: 'Active',
              value: subs.filter((s) => s.status === 'ACTIVE').length,
            },
            { label: 'Monthly recurring (active)', value: monthly.toFixed(2) },
          ],
        };
      }

      case 'employee-growth': {
        const first: Date | null = await this.tenantModel.min('createdAt');
        const from = period.from ?? (first ? new Date(first) : period.to);
        const months = monthsBetween(from, period.to, offset);
        const [orgsByMonth, peopleByMonth, employeesByMonth] =
          await Promise.all([
            this.groupByMonth(
              this.tenantModel,
              this.monthBucket('"createdAt"'),
              {},
            ),
            this.groupByMonth(this.directory, this.monthBucket(PEOPLE_DATE), {
              deletedAt: null,
            }),
            this.groupByMonth(this.directory, this.monthBucket(PEOPLE_DATE), {
              deletedAt: null,
              roleCategory: DirectoryRoleCategory.EMPLOYEE,
            }),
          ]);
        const runningBefore = (map: Map<string, number>, key: string) =>
          [...map].filter(([k]) => k < key).reduce((s, [, v]) => s + v, 0);
        let totalOrgs = months.length
          ? runningBefore(orgsByMonth, months[0].key)
          : 0;
        let totalPeople = months.length
          ? runningBefore(peopleByMonth, months[0].key)
          : 0;
        const rows = months.map((m) => {
          const newOrganizations = orgsByMonth.get(m.key) ?? 0;
          const newPeople = peopleByMonth.get(m.key) ?? 0;
          totalOrgs += newOrganizations;
          totalPeople += newPeople;
          return {
            month: m.label,
            newOrganizations,
            newPeople,
            newEmployees: employeesByMonth.get(m.key) ?? 0,
            totalOrganizations: totalOrgs,
            totalPeople,
          };
        });
        return {
          rows,
          summary: [
            { label: 'Months', value: rows.length },
            {
              label: 'New organizations',
              value: rows.reduce((s, r) => s + r.newOrganizations, 0),
            },
            {
              label: 'People added',
              value: rows.reduce((s, r) => s + r.newPeople, 0),
            },
          ],
        };
      }

      case 'security-audit': {
        const events = await this.authRequest<any[]>(
          MESSAGE_PATTERNS.AUDIT.REPORT_ROWS,
          {
            category: 'security',
            from: period.from?.toISOString(),
            to: period.to.toISOString(),
            status,
            maxRows: 10000,
          },
        );
        if (!events)
          throw new BadRequestException(
            'Security events are unavailable right now (the authentication service did not answer). Try again in a moment.',
          );
        const rows = events.map((e) => ({
          occurredAt: e.createdAt,
          event: humanizeAction(e.action),
          status: e.status,
          organization: e.organizationName || 'Platform',
          user: e.userName || '—',
          email: e.email || '—',
          ipAddress: e.ipAddress || '—',
          device: e.device || '—',
          reason: e.reason
            ? String(e.reason).replace(/_/g, ' ')
            : e.actionDetails || '',
        }));
        return {
          rows,
          summary: [
            { label: 'Events', value: rows.length },
            {
              label: 'Failed',
              value: rows.filter((r) => r.status === 'Failed').length,
            },
            {
              label: 'Different IPs',
              value: new Set(rows.map((r) => r.ipAddress)).size,
            },
          ],
        };
      }
    }
  }

  private async groupByMonth(model: any, bucket: string, where: Row) {
    const grouped = (await model.findAll({
      attributes: [
        [literal(bucket), 'month'],
        [fn('COUNT', literal('*')), 'total'],
      ],
      where,
      group: [literal(bucket) as any],
      raw: true,
    })) as { month: string; total: string }[];
    return new Map(
      grouped.filter((g) => g.month).map((g) => [g.month, Number(g.total)]),
    );
  }

  /**
   * One row per organization from the platform database alone: the tenant,
   * its latest subscription and the directory's headcount rollup.
   */
  private async organizationRows() {
    const [tenants, subscriptions, counters] = await Promise.all([
      this.tenantModel.findAll({ order: [['createdAt', 'DESC']] }),
      this.subscriptionModel.findAll({
        include: [{ model: Plan, attributes: ['name'] }],
        order: [['createdAt', 'DESC']],
      }),
      this.counters.findAll({ raw: true }),
    ]);
    const latest = new Map<string, Subscription>();
    for (const s of subscriptions)
      if (!latest.has(s.tenantId)) latest.set(s.tenantId, s);
    const counts = new Map<string, any>(
      (counters as any[]).map((c) => [c.tenantId, c]),
    );

    return tenants.map((t) => {
      const sub = latest.get(t.id);
      const c = counts.get(t.id);
      return {
        id: t.id,
        organization: t.organizationName || t.name,
        status: this.organizations.deriveStatus(t, sub) as string,
        plan: sub?.plan?.name || t.planType || '—',
        subscriptionStatus: sub?.status ?? null,
        billingCycle: sub?.billingCycle ?? null,
        people: Number(c?.totalUsers ?? 0),
        activePeople: Number(c?.activeUsers ?? 0),
        admins: Number(c?.admins ?? 0),
        hr: Number(c?.hrs ?? 0),
        employees: Number(c?.employees ?? 0),
        adminEmail: t.adminEmail || t.officialEmail || null,
        domain: t.domain || null,
        logoUrl: t.logoUrl || null,
        country: t.country || null,
        industry: t.industry || null,
        createdAt: t.createdAt,
      };
    });
  }

  private async authRequest<T>(
    pattern: string,
    payload: unknown,
  ): Promise<T | null> {
    try {
      return await firstValueFrom(
        this.authClient.send<T>(pattern, payload).pipe(timeout(20000)),
      );
    } catch (err) {
      this.logger.warn(
        `Auth request ${pattern} failed: ${(err as Error)?.message}`,
      );
      return null;
    }
  }

  private signInSummary(from: Date, to: Date, tenantIds?: string[]) {
    return this.authRequest<{
      byTenant: Record<
        string,
        {
          successful: number;
          failed: number;
          uniqueUsers: number;
          lastSignInAt: string | null;
        }
      >;
      totals: { uniqueUsers: number; successful: number };
    }>(MESSAGE_PATTERNS.AUDIT.SIGN_IN_SUMMARY, {
      from: from.toISOString(),
      to: to.toISOString(),
      tenantIds,
    });
  }

  /** The Super Admin's display name, read from the shared platform database. */
  private async actorName(actor?: ReportActor): Promise<string | null> {
    if (!actor?.id) return actor?.email ?? null;
    try {
      const [admin] = await this.tenantModel.sequelize!.query<{
        name: string | null;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
      }>(
        'SELECT name, "firstName", "lastName", email FROM super_admins WHERE id = :id LIMIT 1',
        { replacements: { id: actor.id }, type: QueryTypes.SELECT },
      );
      const name =
        admin?.name?.trim() ||
        [admin?.firstName, admin?.lastName].filter(Boolean).join(' ').trim();
      return name || admin?.email || actor.email || null;
    } catch {
      return actor.email ?? null;
    }
  }

  // ==========================================
  // CSV
  // ==========================================

  private toCsv(columns: ReportColumn[], rows: Row[], offset: number): string {
    const zone = platformTimeZone();
    const header = columns.map((c) =>
      c.type === 'bytes'
        ? `${c.label} (MB)`
        : c.type === 'datetime'
          ? `${c.label} (${zone})`
          : c.label,
    );
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = (value: unknown) => {
      const d = new Date(value as string);
      if (Number.isNaN(d.getTime())) return '';
      const s = new Date(d.getTime() + offset * 60_000);
      return {
        date: `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`,
        time: `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`,
      };
    };
    const cell = (column: ReportColumn, value: unknown): string => {
      if (value === null || value === undefined || value === '') return '';
      switch (column.type) {
        case 'date': {
          const l = local(value);
          return l ? l.date : '';
        }
        case 'datetime': {
          const l = local(value);
          return l ? `${l.date} ${l.time}` : '';
        }
        case 'bytes':
          return (Number(value) / (1024 * 1024)).toFixed(2);
        case 'currency':
          return Number(value).toFixed(2);
        default:
          return String(value);
      }
    };
    // A leading = + - @ would be run as a formula by Excel/Sheets.
    const escape = (text: string) => {
      const safe =
        /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      header.map(escape).join(','),
      ...rows.map((row) =>
        columns.map((c) => escape(cell(c, row[c.key]))).join(','),
      ),
    ];
    return `﻿${lines.join('\r\n')}`;
  }

  // ==========================================
  // Custom reports — saved report definitions
  // ==========================================

  async getCustomReports(query: CustomReportQueryDto) {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit =
      query.limit && query.limit > 0 && query.limit <= 100
        ? Number(query.limit)
        : 10;

    const where: Record<string | symbol, unknown> = { status: 'Active' };
    if (query.category?.trim()) where.category = query.category.trim();
    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      where[Op.or] = [
        { name: { [Op.iLike]: term } },
        { createdBy: { [Op.iLike]: term } },
        { description: { [Op.iLike]: term } },
      ];
    }

    const { count, rows } = await this.customReportModel.findAndCountAll({
      where,
      order: [
        [literal('"lastGeneratedAt" IS NULL'), 'ASC'],
        ['lastGeneratedAt', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit,
      offset: (page - 1) * limit,
    });

    const categories = (await this.customReportModel.findAll({
      attributes: [[fn('DISTINCT', col('category')), 'category']],
      where: { status: 'Active' },
      raw: true,
    })) as unknown as { category: string }[];

    return {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      categories: categories
        .map((c) => c.category)
        .filter(Boolean)
        .sort(),
      data: rows.map((r) => this.toCustomReport(r)),
    };
  }

  private toCustomReport(report: CustomReport) {
    const definition = report.reportType
      ? REPORT_CATALOG[report.reportType as keyof typeof REPORT_CATALOG]
      : null;
    return {
      id: report.id,
      name: report.name,
      description: report.description,
      reportType: definition ? report.reportType : null,
      reportTitle: definition?.title ?? null,
      category: report.category,
      filters: report.filters ?? {},
      columns: report.columns ?? null,
      createdBy: report.createdBy,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      lastGeneratedAt: report.lastGeneratedAt,
    };
  }

  async getCustomReportById(id: string) {
    return this.toCustomReport(await this.findCustomReport(id));
  }

  private async findCustomReport(id: string) {
    const report = await this.customReportModel.findByPk(id);
    if (!report || report.status !== 'Active')
      throw new NotFoundException('This report no longer exists.');
    return report;
  }

  /** Checks the filters against the report they're for, so a saved report can't fail later. */
  private validDefinition(
    reportType: string,
    filters?: ReportFiltersDto,
    columns?: string[] | null,
  ) {
    const definition = reportDefinition(reportType);
    selectColumns(definition, columns);
    resolvePeriod(filters, definition.defaultPeriod, new Date(), this.offset());
    if (
      filters?.status &&
      !definition.statusFilter?.options.some((o) => o.value === filters.status)
    ) {
      throw new BadRequestException(
        `${definition.title} can't be filtered by “${filters.status}”.`,
      );
    }
    return definition;
  }

  private cleanFilters(filters?: ReportFiltersDto) {
    if (!filters) return {};
    return {
      ...(filters.period ? { period: filters.period } : {}),
      ...(filters.period === 'custom'
        ? { from: filters.from, to: filters.to }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
  }

  async createCustomReport(dto: CreateCustomReportDto, actor?: ReportActor) {
    const definition = this.validDefinition(
      dto.reportType,
      dto.filters,
      dto.columns,
    );
    const report = await this.customReportModel.create({
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      reportType: definition.id,
      category: definition.category,
      filters: this.cleanFilters(dto.filters),
      columns: dto.columns?.length ? dto.columns : null,
      createdBy: (await this.actorName(actor)) || 'Super Admin',
      createdById: actor?.id ?? null,
      status: 'Active',
      lastGeneratedAt: null,
    });
    return this.toCustomReport(report);
  }

  async updateCustomReport(id: string, dto: UpdateCustomReportDto) {
    const report = await this.findCustomReport(id);
    const reportType = dto.reportType ?? report.reportType;
    if (!reportType)
      throw new BadRequestException('Choose which report this is built on.');
    const filters =
      dto.filters !== undefined
        ? dto.filters
        : (report.filters as ReportFiltersDto);
    const columns = dto.columns !== undefined ? dto.columns : report.columns;
    const definition = this.validDefinition(reportType, filters, columns);

    await report.update({
      name: dto.name?.trim() ?? report.name,
      description:
        dto.description !== undefined
          ? dto.description.trim() || null
          : report.description,
      reportType: definition.id,
      category: definition.category,
      filters: this.cleanFilters(filters),
      columns: columns?.length ? columns : null,
    });
    return this.toCustomReport(report);
  }

  async duplicateCustomReport(id: string, actor?: ReportActor) {
    const source = await this.findCustomReport(id);
    const copy = await this.customReportModel.create({
      name: `${source.name} (copy)`.slice(0, 120),
      description: source.description,
      reportType: source.reportType,
      category: source.category,
      filters: source.filters,
      columns: source.columns,
      createdBy: (await this.actorName(actor)) || 'Super Admin',
      createdById: actor?.id ?? null,
      status: 'Active',
      lastGeneratedAt: null,
    });
    return this.toCustomReport(copy);
  }

  async deleteCustomReport(id: string) {
    const report = await this.findCustomReport(id);
    const name = report.name;
    await report.destroy();
    return { success: true, message: `“${name}” was deleted.`, name };
  }

  /** Runs a saved report with its own filters and columns. */
  async runCustomReport(id: string, actor?: ReportActor) {
    const report = await this.findCustomReport(id);
    if (!report.reportType) {
      throw new BadRequestException(
        'This report was saved before reports were linked to data. Edit it and choose which report it runs.',
      );
    }
    return this.generateReport(
      {
        reportType: report.reportType as GenerateReportDto['reportType'],
        filters: (report.filters ?? {}) as ReportFiltersDto,
        columns: report.columns ?? undefined,
        customReportId: report.id,
        title: report.name,
      },
      actor,
    );
  }
}

const formatBytes = (bytes: number) => {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
};
