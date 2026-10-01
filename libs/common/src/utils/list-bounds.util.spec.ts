import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  buildPaginatedResult,
  resolveListBounds,
} from './list-bounds.util';

describe('resolveListBounds', () => {
  it('applies the default limit when the caller asks for nothing', () => {
    expect(resolveListBounds(undefined)).toEqual({
      limit: DEFAULT_LIST_LIMIT,
      offset: 0,
    });
  });

  it('translates a 1-based page into an offset', () => {
    expect(resolveListBounds({ page: 3, limit: 10 })).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it('prefers an explicit offset over page', () => {
    expect(resolveListBounds({ page: 5, offset: 7, limit: 10 })).toEqual({
      limit: 10,
      offset: 7,
    });
  });

  // Clamped rather than rejected: these values arrive from query strings and
  // RPC payloads where a bad number is far more likely to be a careless
  // client than an attack, and clamping keeps the request cheap instead of
  // turning it into either an error page or a full-table scan.
  it('clamps a limit above the maximum', () => {
    expect(resolveListBounds({ limit: 10_000_000 }).limit).toBe(MAX_LIST_LIMIT);
  });

  it('falls back to the default for a zero or negative limit', () => {
    expect(resolveListBounds({ limit: 0 }).limit).toBe(DEFAULT_LIST_LIMIT);
    expect(resolveListBounds({ limit: -5 }).limit).toBe(DEFAULT_LIST_LIMIT);
  });

  it('falls back to the default for a non-numeric limit', () => {
    expect(resolveListBounds({ limit: 'abc' as any }).limit).toBe(
      DEFAULT_LIST_LIMIT,
    );
    expect(resolveListBounds({ limit: NaN }).limit).toBe(DEFAULT_LIST_LIMIT);
  });

  it('treats a zero or negative page as the first page', () => {
    expect(resolveListBounds({ page: 0, limit: 10 }).offset).toBe(0);
    expect(resolveListBounds({ page: -3, limit: 10 }).offset).toBe(0);
  });

  it('floors fractional input rather than passing it to SQL', () => {
    expect(resolveListBounds({ page: 2.7, limit: 10.9 })).toEqual({
      limit: 10,
      offset: 10,
    });
  });

  it('accepts offset 0 as an explicit offset', () => {
    expect(resolveListBounds({ page: 4, offset: 0, limit: 10 }).offset).toBe(0);
  });
});

describe('buildPaginatedResult', () => {
  it('reports more pages remaining', () => {
    const result = buildPaginatedResult(['a', 'b'], 10, {
      limit: 2,
      offset: 0,
    });
    expect(result).toEqual({
      rows: ['a', 'b'],
      total: 10,
      limit: 2,
      offset: 0,
      hasMore: true,
    });
  });

  it('reports the last page', () => {
    const result = buildPaginatedResult(['i', 'j'], 10, {
      limit: 2,
      offset: 8,
    });
    expect(result.hasMore).toBe(false);
  });

  it('reports no more pages for an empty result', () => {
    const result = buildPaginatedResult([], 0, { limit: 25, offset: 0 });
    expect(result.hasMore).toBe(false);
  });
});
