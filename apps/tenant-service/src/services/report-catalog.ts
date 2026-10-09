import { BadRequestException } from '@nestjs/common';
import {
  localClock,
  ReportFiltersDto,
  ReportPeriod,
  ReportType,
  REPORT_TYPES,
} from '@app/common';

export type ReportColumnType =
  'text' | 'number' | 'date' | 'datetime' | 'bytes' | 'currency' | 'status';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export interface ReportDefinition {
  id: ReportType;
  title: string;
  description: string;
  category: string;
  /** What the period narrows, e.g. "Created". Null when the report is a snapshot of now. */
  periodApplies: string | null;
  defaultPeriod: ReportPeriod;
  statusFilter?: { label: string; options: { value: string; label: string }[] };
  columns: ReportColumn[];
}

const ORG_STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'TRIAL', label: 'Trial' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'DEACTIVATED', label: 'Deactivated' },
];

/**
 * The platform reports. Each one is generated from live data by
 * `PlatformReportsService`; this file only describes them — the Reports page
 * builds its cards, filters and column pickers from it.
 */
export const REPORT_CATALOG: Record<ReportType, ReportDefinition> = {
  'organization-summary': {
    id: 'organization-summary',
    title: 'Organization Summary',
    description:
      'Every organization with its status, plan, headcount and admin contact.',
    category: 'Organizations',
    periodApplies: 'Created',
    defaultPeriod: 'all-time',
    statusFilter: { label: 'Organization status', options: ORG_STATUS_OPTIONS },
    columns: [
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'plan', label: 'Plan', type: 'text' },
      { key: 'subscriptionStatus', label: 'Subscription', type: 'status' },
      { key: 'billingCycle', label: 'Billing cycle', type: 'text' },
      { key: 'people', label: 'People', type: 'number' },
      { key: 'activePeople', label: 'Active people', type: 'number' },
      { key: 'admins', label: 'Admins', type: 'number' },
      { key: 'hr', label: 'HR', type: 'number' },
      { key: 'employees', label: 'Employees', type: 'number' },
      { key: 'adminEmail', label: 'Admin email', type: 'text' },
      { key: 'domain', label: 'Domain', type: 'text' },
      { key: 'country', label: 'Country', type: 'text' },
      { key: 'industry', label: 'Industry', type: 'text' },
      { key: 'createdAt', label: 'Created', type: 'date' },
    ],
  },
  'user-activity': {
    id: 'user-activity',
    title: 'User Activity Report',
    description:
      'Sign-ins per organization: how many, how many failed, and who was active.',
    category: 'Users',
    periodApplies: 'Sign-ins',
    defaultPeriod: 'last-30-days',
    statusFilter: { label: 'Organization status', options: ORG_STATUS_OPTIONS },
    columns: [
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'people', label: 'People', type: 'number' },
      { key: 'activePeople', label: 'Active accounts', type: 'number' },
      { key: 'usersSignedIn', label: 'People who signed in', type: 'number' },
      { key: 'signIns', label: 'Sign-ins', type: 'number' },
      { key: 'failedSignIns', label: 'Failed sign-ins', type: 'number' },
      { key: 'lastSignInAt', label: 'Last sign-in', type: 'datetime' },
    ],
  },
  'subscription-reports': {
    id: 'subscription-reports',
    title: 'Subscription Report',
    description:
      'Each organization’s subscription: plan, price, billing dates and payment state.',
    category: 'Subscriptions',
    periodApplies: 'Started',
    defaultPeriod: 'all-time',
    statusFilter: {
      label: 'Subscription status',
      options: [
        { value: 'ACTIVE', label: 'Active' },
        { value: 'TRIAL', label: 'Trial' },
        { value: 'PENDING_PAYMENT', label: 'Pending payment' },
        { value: 'PAST_DUE', label: 'Past due' },
        { value: 'SUSPENDED', label: 'Suspended' },
        { value: 'CANCELLED', label: 'Cancelled' },
      ],
    },
    columns: [
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'plan', label: 'Plan', type: 'text' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'billingCycle', label: 'Billing cycle', type: 'text' },
      { key: 'price', label: 'Price', type: 'currency' },
      { key: 'startDate', label: 'Started', type: 'date' },
      { key: 'nextBillingDate', label: 'Next billing', type: 'date' },
      { key: 'pastDueAt', label: 'Past due since', type: 'date' },
      { key: 'gracePeriodEndsAt', label: 'Grace period ends', type: 'date' },
      { key: 'cancelledAt', label: 'Cancelled', type: 'date' },
      { key: 'cancellationReason', label: 'Cancellation reason', type: 'text' },
    ],
  },
  'employee-growth': {
    id: 'employee-growth',
    title: 'People Growth Report',
    description:
      'Month by month: new organizations, people added, and the running totals.',
    category: 'People',
    periodApplies: 'Months',
    defaultPeriod: 'last-12-months',
    columns: [
      { key: 'month', label: 'Month', type: 'text' },
      { key: 'newOrganizations', label: 'New organizations', type: 'number' },
      { key: 'newPeople', label: 'People added', type: 'number' },
      { key: 'newEmployees', label: 'Employees added', type: 'number' },
      {
        key: 'totalOrganizations',
        label: 'Organizations (end of month)',
        type: 'number',
      },
      { key: 'totalPeople', label: 'People (end of month)', type: 'number' },
    ],
  },
  'system-usage': {
    id: 'system-usage',
    title: 'System Usage Report',
    description:
      'Database size, headcount and sign-in volume for each organization.',
    category: 'System',
    periodApplies: 'Sign-ins',
    defaultPeriod: 'last-30-days',
    statusFilter: { label: 'Organization status', options: ORG_STATUS_OPTIONS },
    columns: [
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'databaseSize', label: 'Database size', type: 'bytes' },
      { key: 'people', label: 'People', type: 'number' },
      { key: 'signIns', label: 'Sign-ins', type: 'number' },
      { key: 'lastSignInAt', label: 'Last sign-in', type: 'datetime' },
    ],
  },
  'security-audit': {
    id: 'security-audit',
    title: 'Security & Audit Report',
    description:
      'Failed sign-ins, wrong 2FA codes and every change to access control.',
    category: 'Security',
    periodApplies: 'Events',
    defaultPeriod: 'last-30-days',
    statusFilter: {
      label: 'Result',
      options: [
        { value: 'Failed', label: 'Failed' },
        { value: 'Success', label: 'Succeeded' },
      ],
    },
    columns: [
      { key: 'occurredAt', label: 'Date & time', type: 'datetime' },
      { key: 'event', label: 'Event', type: 'text' },
      { key: 'status', label: 'Result', type: 'status' },
      { key: 'organization', label: 'Organization', type: 'text' },
      { key: 'user', label: 'User', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'ipAddress', label: 'IP address', type: 'text' },
      { key: 'device', label: 'Device', type: 'text' },
      { key: 'reason', label: 'Reason', type: 'text' },
    ],
  },
};

export const reportDefinition = (
  type: string | null | undefined,
): ReportDefinition => {
  const definition =
    type && (REPORT_TYPES as readonly string[]).includes(type)
      ? REPORT_CATALOG[type as ReportType]
      : null;
  if (!definition) throw new BadRequestException('Choose which report to run.');
  return definition;
};

/** The chosen columns that exist, in catalog order; every column when none are chosen. */
export const selectColumns = (
  definition: ReportDefinition,
  keys?: string[] | null,
): ReportColumn[] => {
  if (!keys?.length) return definition.columns;
  const picked = definition.columns.filter((c) => keys.includes(c.key));
  if (!picked.length)
    throw new BadRequestException('Pick at least one column.');
  return picked;
};

export interface ResolvedPeriod {
  period: ReportPeriod;
  from: Date | null;
  to: Date;
  label: string;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Local calendar parts of an instant, at a UTC offset in minutes. */
const localParts = (at: Date, offset: number) => {
  const shifted = new Date(at.getTime() + offset * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
};
const localDate = (year: number, month: number, day: number, offset: number) =>
  new Date(Date.UTC(year, month, day) - offset * 60_000);

/**
 * Turns a period choice into an instant range in the platform's time zone,
 * so "this month" starts at local midnight on the 1st, not UTC's.
 */
export const resolvePeriod = (
  filters: ReportFiltersDto | undefined,
  fallback: ReportPeriod,
  now: Date,
  offset: number,
): ResolvedPeriod => {
  const period = filters?.period ?? fallback;
  const today = localClock(now, offset).dayStart;
  const { year, month } = localParts(now, offset);
  const DAY = 24 * 60 * 60 * 1000;
  const fmt = (d: Date) => {
    const p = localParts(d, offset);
    return `${p.day} ${MONTHS[p.month]} ${p.year}`;
  };

  switch (period) {
    case 'last-7-days':
      return {
        period,
        from: new Date(today.getTime() - 6 * DAY),
        to: now,
        label: 'Last 7 days',
      };
    case 'last-30-days':
      return {
        period,
        from: new Date(today.getTime() - 29 * DAY),
        to: now,
        label: 'Last 30 days',
      };
    case 'last-90-days':
      return {
        period,
        from: new Date(today.getTime() - 89 * DAY),
        to: now,
        label: 'Last 90 days',
      };
    case 'this-month':
      return {
        period,
        from: localDate(year, month, 1, offset),
        to: now,
        label: `${MONTHS[month]} ${year}`,
      };
    case 'last-month': {
      const from = localDate(year, month - 1, 1, offset);
      const p = localParts(from, offset);
      return {
        period,
        from,
        to: new Date(localDate(year, month, 1, offset).getTime() - 1),
        label: `${MONTHS[p.month]} ${p.year}`,
      };
    }
    case 'last-12-months':
      return {
        period,
        from: localDate(year, month - 11, 1, offset),
        to: now,
        label: 'Last 12 months',
      };
    case 'this-year':
      return {
        period,
        from: localDate(year, 0, 1, offset),
        to: now,
        label: String(year),
      };
    case 'custom': {
      if (!filters?.from || !filters?.to)
        throw new BadRequestException('Choose both a start and an end date.');
      const [fy, fm, fd] = filters.from.slice(0, 10).split('-').map(Number);
      const [ty, tm, td] = filters.to.slice(0, 10).split('-').map(Number);
      const from = localDate(fy, fm - 1, fd, offset);
      const to = new Date(localDate(ty, tm - 1, td + 1, offset).getTime() - 1);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        throw new BadRequestException('Those dates are not valid.');
      if (from > to)
        throw new BadRequestException(
          'The start date has to be before the end date.',
        );
      return { period, from, to, label: `${fmt(from)} – ${fmt(to)}` };
    }
    case 'all-time':
    default:
      return { period: 'all-time', from: null, to: now, label: 'All time' };
  }
};

/** Month keys "YYYY-MM" (local) from the month of `from` to the month of `to`. */
export const monthsBetween = (
  from: Date,
  to: Date,
  offset: number,
): { key: string; label: string; end: Date; start: Date }[] => {
  const start = localParts(from, offset);
  const end = localParts(to, offset);
  const months: { key: string; label: string; end: Date; start: Date }[] = [];
  let y = start.year;
  let m = start.month;
  while (y < end.year || (y === end.year && m <= end.month)) {
    months.push({
      key: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: `${MONTHS[m]} ${y}`,
      start: localDate(y, m, 1, offset),
      end: new Date(localDate(y, m + 1, 1, offset).getTime() - 1),
    });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    if (months.length > 240) break;
  }
  return months;
};
