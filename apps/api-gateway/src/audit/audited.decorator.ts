import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const AUDITED_KEY = 'audit:action';

export type AuditService = 'auth' | 'tenant' | 'user';

export interface AuditContext {
  req: Request & { user?: any };
  params: Record<string, string>;
  body: any;
  query: any;
  /** What the handler returned (undefined when it failed). */
  result?: any;
  /** The record as it was before the action, when `snapshot` is set. */
  before?: any;
}

export interface AuditedOptions {
  /** Machine name of what happened, e.g. 'ORGANIZATION_DELETED'. May depend on the request. */
  action: string | ((ctx: AuditContext) => string);
  /** The area of the platform, e.g. 'Organizations'. */
  module: string;
  /** Route param holding the organization (tenant) id the action is about. */
  tenantParam?: string;
  /** The thing acted on, shown under the action, e.g. a plan or domain name. */
  subject?: (ctx: AuditContext) => string | null | undefined;
  /**
   * Reads the record before the handler runs. With `diff`, the body's fields
   * are compared against it so the trail shows exactly what changed, old and
   * new; it is also where a deleted record's name comes from.
   */
  snapshot?: {
    service: AuditService;
    pattern: string;
    payload?: (ctx: AuditContext) => unknown;
    pick?: (raw: any, ctx: AuditContext) => any;
  };
  /** Record body fields that differ from the snapshot as changes. */
  diff?: boolean;
}

/**
 * Marks a Super Admin route for the platform audit trail. The work is done by
 * `AuditTrailInterceptor`; this only describes the event.
 */
export const Audited = (options: AuditedOptions) =>
  SetMetadata(AUDITED_KEY, options);
