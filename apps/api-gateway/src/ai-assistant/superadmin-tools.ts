import type Anthropic from '@anthropic-ai/sdk';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  MESSAGE_PATTERNS,
  OrganizationStatusFilter,
  ORGANIZATION_SORTABLE_FIELDS,
  SubscriptionStatus,
} from '@app/common';

export interface AiToolContext {
  authClient: ClientProxy;
  tenantClient: ClientProxy;
  userClient: ClientProxy;
}

type JsonSchemaProperty = {
  type: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
};

interface ToolSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface AiTool {
  name: string;
  /** Shown in the chat panel while the tool runs, e.g. "Billing metrics". */
  label: string;
  description: string;
  input_schema: ToolSchema;
  run: (input: Record<string, unknown>, ctx: AiToolContext) => Promise<unknown>;
}

/**
 * Every Super Admin tool is read-only and maps 1:1 onto a message pattern the
 * existing `superadmin/*` routes already send, with the same payload shape —
 * so the assistant reads exactly what the dashboards read. Access is enforced
 * on the chat route itself (superadmin role + SuperAdminGuard + IP allowlist),
 * which every one of these routes shares.
 */
const send = (client: ClientProxy, pattern: string, payload: unknown) =>
  firstValueFrom(client.send(pattern, payload ?? {}));

const noInput: ToolSchema = { type: 'object', properties: {}, additionalProperties: false };

const pageProps = {
  page: { type: 'integer', minimum: 1, description: 'Page number, starting at 1' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Rows per page (max 50)' },
} as const;

export const SUPERADMIN_TOOLS: AiTool[] = [
  {
    name: 'get_organization_stats',
    label: 'Organization stats',
    description:
      'Counts of organizations by status (total, active, trial, pending, deactivated) and the month-over-month % change in new organizations for each status.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_STATS, {}),
  },
  {
    name: 'list_organizations',
    label: 'Organizations',
    description:
      'Paged list of organizations with plan, derived status, primary admin, user count, join date and subscription summary. Filter by name/domain search, status or plan name.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', maxLength: 100, description: 'Matches organization name or domain' },
        status: { type: 'string', enum: Object.values(OrganizationStatusFilter) },
        planType: { type: 'string', maxLength: 100, description: 'Exact plan name, e.g. "Enterprise"' },
        sortBy: { type: 'string', enum: ORGANIZATION_SORTABLE_FIELDS },
        sortOrder: { type: 'string', enum: ['ASC', 'DESC'] },
        ...pageProps,
      },
      additionalProperties: false,
    },
    run: (input, ctx) =>
      send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALL, { page: 1, limit: 20, ...input }),
  },
  {
    name: 'get_organization_details',
    label: 'Organization details',
    description:
      'Full details for one organization by its tenantId (from list_organizations): profile, plan, status, admin and subscription.',
    input_schema: {
      type: 'object',
      properties: { tenantId: { type: 'string', maxLength: 64, description: 'The organization id' } },
      required: ['tenantId'],
      additionalProperties: false,
    },
    run: (input, ctx) =>
      send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ONE, { tenantId: input.tenantId }),
  },
  {
    name: 'get_organizations_overview',
    label: 'Monthly registrations',
    description:
      'Organizations registered in each of the last N months, split by the status each holds today. It does not show what status an organization had in a past month.',
    input_schema: {
      type: 'object',
      properties: { months: { type: 'integer', minimum: 1, maximum: 24, description: 'Window in months (default 6)' } },
      additionalProperties: false,
    },
    run: (input, ctx) =>
      send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_OVERVIEW, { months: input.months ?? 6 }),
  },
  {
    name: 'get_organizations_by_plan',
    label: 'Organizations by plan',
    description: 'Number of organizations on each plan (current subscription plan, or "No Plan").',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_PLAN_BREAKDOWN, {}),
  },
  {
    name: 'get_platform_alerts',
    label: 'Platform alerts',
    description:
      'Current conditions needing action: failed database provisioning, overdue/suspended subscriptions, organizations pending activation, trials ending and subscriptions renewing within 7 days.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_ORGANIZATIONS.GET_ALERTS, {}),
  },
  {
    name: 'get_billing_metrics',
    label: 'Billing metrics',
    description:
      'Platform revenue and billing totals: total plans, organizations subscribed, active subscriptions, MRR, total revenue, pending and failed payments, overdue invoices, cancelled and suspended subscriptions.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.GET_METRICS, {}),
  },
  {
    name: 'list_subscriptions',
    label: 'Subscriptions',
    description: 'Paged list of subscriptions across all organizations with plan and organization, optionally filtered by status.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: Object.values(SubscriptionStatus) }, ...pageProps },
      additionalProperties: false,
    },
    run: (input, ctx) =>
      send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.SUPERADMIN_GET_SUBSCRIPTIONS, { page: 1, limit: 20, ...input }),
  },
  {
    name: 'get_upcoming_renewals',
    label: 'Upcoming renewals',
    description: 'Subscriptions whose next billing date falls within the given number of days.',
    input_schema: {
      type: 'object',
      properties: { thresholdDays: { type: 'integer', minimum: 1, maximum: 365, description: 'Look-ahead in days (default 7)' } },
      additionalProperties: false,
    },
    run: (input, ctx) =>
      send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.UPCOMING_RENEWALS, { thresholdDays: input.thresholdDays ?? 7 }),
  },
  {
    name: 'get_billing_risks',
    label: 'Overdue & suspended',
    description: 'Overdue (past due) and suspended subscriptions, each with its organization.',
    input_schema: noInput,
    run: async (_, ctx) => {
      const [overdue, suspended] = await Promise.all([
        send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.OVERDUE_SUBSCRIPTIONS, {}),
        send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.SUSPENDED_SUBSCRIPTIONS, {}),
      ]);
      return { overdue, suspended };
    },
  },
  {
    name: 'list_plans',
    label: 'Plans',
    description: 'Billing plans with prices, limits and whether they are active or custom.',
    input_schema: {
      type: 'object',
      properties: { isActive: { type: 'boolean' } },
      additionalProperties: false,
    },
    run: (input, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.BILLING.GET_PLANS, input),
  },
  {
    name: 'get_platform_growth',
    label: 'Platform growth',
    description:
      'Cumulative organizations per month for the last 6 or 12 months. The "Users" series in this result is an estimate, not a real count — never present it as exact.',
    input_schema: {
      type: 'object',
      properties: { period: { type: 'string', enum: ['6months', '12months'] } },
      additionalProperties: false,
    },
    run: (input, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.REPORTS.GET_PLATFORM_GROWTH, input),
  },
  {
    name: 'get_top_organizations',
    label: 'Top organizations',
    description: 'Organizations ranked by number of employees.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
    run: (input, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.REPORTS.GET_TOP_ORGANIZATIONS, input),
  },
  {
    name: 'get_user_stats',
    label: 'User counts',
    description: 'Total platform users across all organizations, and counts of admins, HR users and employees.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.userClient, MESSAGE_PATTERNS.PLATFORM_CLIENTS.GET_STATS, {}),
  },
  {
    name: 'search_audit_logs',
    label: 'Audit logs',
    description:
      'Platform audit trail: who did what and when (logins, organization changes, subscription changes, settings). Filter by free-text search, module, status, action code, email, tenantId and ISO date range.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', maxLength: 100 },
        module: { type: 'string', maxLength: 60, description: 'e.g. Subscriptions, Users, Roles & Permissions, Authentication, Reports' },
        status: { type: 'string', enum: ['Active', 'Success', 'Failed', 'Warning'] },
        action: { type: 'string', maxLength: 60, description: 'Action code, e.g. LOGIN_FAILED' },
        email: { type: 'string', maxLength: 120 },
        tenantId: { type: 'string', maxLength: 64 },
        from: { type: 'string', maxLength: 30, description: 'ISO date, inclusive' },
        to: { type: 'string', maxLength: 30, description: 'ISO date, inclusive' },
        ...pageProps,
      },
      additionalProperties: false,
    },
    run: (input, ctx) => send(ctx.authClient, MESSAGE_PATTERNS.AUDIT.QUERY_LOGS, { page: 1, limit: 20, ...input }),
  },
  {
    name: 'get_audit_stats',
    label: 'Audit summary',
    description: 'Audit log totals: all activities, today, security events and failed actions.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.authClient, MESSAGE_PATTERNS.AUDIT.GET_STATS, {}),
  },
  {
    name: 'get_platform_status',
    label: 'Platform health',
    description:
      'Live platform health: overall status, each service and component (database, storage, email), storage used vs quota, and the last successful backup.',
    input_schema: noInput,
    run: (_, ctx) => send(ctx.tenantClient, MESSAGE_PATTERNS.PLATFORM_STATUS.GET_STATUS, {}),
  },
];

/**
 * The model is told the schema, but tool input is still untrusted output, so
 * it is checked here before anything is sent to a service: unknown keys,
 * wrong types, out-of-range numbers and values outside an enum are rejected.
 */
export const validateToolInput = (
  tool: AiTool,
  raw: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Input must be a JSON object.' };
  }
  const input = raw as Record<string, unknown>;
  const { properties, required = [] } = tool.input_schema;

  for (const key of Object.keys(input)) {
    if (!properties[key]) return { ok: false, error: `Unknown field "${key}".` };
  }
  for (const key of required) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      return { ok: false, error: `"${key}" is required.` };
    }
  }

  const value: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') return { ok: false, error: `"${key}" must be a string.` };
        if (spec.maxLength && v.length > spec.maxLength) return { ok: false, error: `"${key}" is too long.` };
        if (spec.enum && !spec.enum.includes(v)) {
          return { ok: false, error: `"${key}" must be one of: ${spec.enum.join(', ')}.` };
        }
        break;
      case 'integer':
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v) || (spec.type === 'integer' && !Number.isInteger(v))) {
          return { ok: false, error: `"${key}" must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}.` };
        }
        if (spec.minimum !== undefined && v < spec.minimum) return { ok: false, error: `"${key}" must be at least ${spec.minimum}.` };
        if (spec.maximum !== undefined && v > spec.maximum) return { ok: false, error: `"${key}" must be at most ${spec.maximum}.` };
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, error: `"${key}" must be true or false.` };
        break;
    }
    value[key] = v;
  }
  return { ok: true, value };
};

/** Tool definitions as the Messages API expects them (deterministic order keeps the prompt cache warm). */
export const toApiTools = (tools: AiTool[]): Anthropic.Beta.BetaTool[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as unknown as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
