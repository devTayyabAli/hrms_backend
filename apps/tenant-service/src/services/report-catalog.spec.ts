import { BadRequestException } from '@nestjs/common';
import { REPORT_TYPES } from '@app/common';
import {
  REPORT_CATALOG,
  monthsBetween,
  reportDefinition,
  resolvePeriod,
  selectColumns,
} from './report-catalog';

const PKT = 300; // UTC+05:00
// 9 Oct 2026, 15:00 in Karachi.
const NOW = new Date('2026-10-09T10:00:00.000Z');

describe('report catalog', () => {
  it('describes every report type', () => {
    for (const type of REPORT_TYPES)
      expect(REPORT_CATALOG[type].columns.length).toBeGreaterThan(0);
  });

  it('refuses an unknown report', () => {
    expect(() => reportDefinition('payroll')).toThrow(BadRequestException);
  });

  it('keeps chosen columns in catalog order and refuses an empty pick', () => {
    const def = reportDefinition('organization-summary');
    expect(
      selectColumns(def, ['people', 'organization']).map((c) => c.key),
    ).toEqual(['organization', 'people']);
    expect(() => selectColumns(def, ['nope'])).toThrow(BadRequestException);
    expect(selectColumns(def)).toHaveLength(def.columns.length);
  });
});

describe('resolvePeriod', () => {
  it('starts "this month" at local midnight on the 1st', () => {
    const p = resolvePeriod({ period: 'this-month' }, 'all-time', NOW, PKT);
    expect(p.from?.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(p.label).toBe('Oct 2026');
  });

  it('covers the whole of last month', () => {
    const p = resolvePeriod({ period: 'last-month' }, 'all-time', NOW, PKT);
    expect(p.from?.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-09-30T18:59:59.999Z');
    expect(p.label).toBe('Sep 2026');
  });

  it('counts today as one of the last 7 days', () => {
    const p = resolvePeriod({ period: 'last-7-days' }, 'all-time', NOW, PKT);
    expect(p.from?.toISOString()).toBe('2026-10-02T19:00:00.000Z');
  });

  it('makes a custom range inclusive of its end date', () => {
    const p = resolvePeriod(
      { period: 'custom', from: '2026-01-01', to: '2026-01-31' },
      'all-time',
      NOW,
      PKT,
    );
    expect(p.from?.toISOString()).toBe('2025-12-31T19:00:00.000Z');
    expect(p.to.toISOString()).toBe('2026-01-31T18:59:59.999Z');
  });

  it('refuses a custom range that runs backwards or is missing a date', () => {
    expect(() =>
      resolvePeriod(
        { period: 'custom', from: '2026-02-01', to: '2026-01-01' },
        'all-time',
        NOW,
        PKT,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      resolvePeriod(
        { period: 'custom', from: '2026-02-01' },
        'all-time',
        NOW,
        PKT,
      ),
    ).toThrow(BadRequestException);
  });

  it('falls back to the report default and treats all-time as unbounded', () => {
    expect(resolvePeriod(undefined, 'last-30-days', NOW, PKT).label).toBe(
      'Last 30 days',
    );
    expect(
      resolvePeriod({ period: 'all-time' }, 'last-30-days', NOW, PKT).from,
    ).toBeNull();
  });
});

describe('monthsBetween', () => {
  it('lists local months across a year end', () => {
    const months = monthsBetween(
      new Date('2025-11-15T00:00:00Z'),
      new Date('2026-02-10T00:00:00Z'),
      PKT,
    );
    expect(months.map((m) => m.key)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(months[0].label).toBe('Nov 2025');
  });
});
