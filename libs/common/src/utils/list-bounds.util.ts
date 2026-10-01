/**
 * Bounds for a list query that must never run unbounded.
 *
 * `findAll` with no `limit` is fine on a table you know is small and a
 * liability on one you don't. Tenant user and role tables are the second
 * kind: they start tiny, grow with headcount, and are read on screens that
 * only ever render a page at a time. An unbounded read there loads every row
 * (plus its eager-loaded join rows) into the service's heap, serializes the
 * lot into a single TCP message, and hands the gateway a payload whose size
 * is set by the largest tenant on the platform.
 *
 * These helpers give such a query an explicit ceiling and optional paging
 * without changing its return shape, so existing callers keep working while
 * the worst case stops being "however many rows exist".
 */

/** Ceiling applied when a caller asks for no particular page size. */
export const DEFAULT_LIST_LIMIT = 200;

/** Ceiling a caller can never exceed, whatever they pass. */
export const MAX_LIST_LIMIT = 1000;

export interface ListBoundsInput {
  /** 1-based page number. Ignored when `offset` is given. */
  page?: number;
  limit?: number;
  offset?: number;
}

export interface ListBounds {
  limit: number;
  offset: number;
}

/**
 * Normalizes caller-supplied paging into a `limit`/`offset` pair that is
 * always present and always sane.
 *
 * Every input is clamped rather than rejected: these values reach us from
 * query strings and RPC payloads where a `limit=0`, `limit=-1` or
 * `limit=999999999` is far more likely to be a careless client than an
 * attack, and clamping keeps such a request cheap instead of turning it into
 * either an error page or a full-table scan.
 */
export function resolveListBounds(
  input: ListBoundsInput | undefined,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  maxLimit: number = MAX_LIST_LIMIT,
): ListBounds {
  const rawLimit = Number(input?.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), maxLimit)
      : Math.min(defaultLimit, maxLimit);

  const rawOffset = Number(input?.offset);
  if (Number.isFinite(rawOffset) && rawOffset >= 0) {
    return { limit, offset: Math.floor(rawOffset) };
  }

  const rawPage = Number(input?.page);
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  return { limit, offset: (page - 1) * limit };
}

/** Standard envelope for a bounded list, so callers can tell there is more. */
export interface PaginatedResult<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function buildPaginatedResult<T>(
  rows: T[],
  total: number,
  bounds: ListBounds,
): PaginatedResult<T> {
  return {
    rows,
    total,
    limit: bounds.limit,
    offset: bounds.offset,
    hasMore: bounds.offset + rows.length < total,
  };
}
