/**
 * Hard ceiling on rows returned by any CSV export handler.
 *
 * Exports build the whole result set in memory and serialize it into one RPC
 * message before the gateway turns it into a CSV string, so an unbounded
 * `findAll` over a large tenant is a memory and timeout risk on both sides.
 * The cap keeps that bounded; callers needing more should narrow their
 * filters (date range, department) rather than pull the full history.
 *
 * Exports that hit the cap say so in their response metadata instead of
 * silently truncating, so the caller can tell a complete export from a
 * clipped one.
 */
export const EXPORT_MAX_ROWS = 10000;

/** Envelope every export handler returns, so truncation is always visible. */
export interface ExportResult<T> {
  rows: T[];
  /** Rows matching the filters before the cap was applied. */
  totalMatched: number;
  /** True when `rows` is shorter than `totalMatched` because of the cap. */
  truncated: boolean;
  limit: number;
}
