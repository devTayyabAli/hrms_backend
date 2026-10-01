import { of } from 'rxjs';
import { MESSAGE_PATTERNS, EXPORT_MAX_ROWS } from '@app/common';
import { AttendanceController } from './attendance.controller';

/**
 * Pins the CSV export response contract: header row, quoting of values that
 * contain delimiters, nested field flattening, download headers, and the
 * truncation signal that tells a caller a capped export is not the full set.
 */
describe('AttendanceController export', () => {
  let controller: AttendanceController;
  let send: jest.Mock;
  let res: { setHeader: jest.Mock };

  const TENANT = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    send = jest.fn();
    controller = new AttendanceController({ send } as any);
    res = { setHeader: jest.fn() };
  });

  const row = (over: Record<string, any> = {}) => ({
    date: '2026-09-11',
    employee: { employeeCode: 'EMP001', name: 'Ayesha Khan' },
    department: { name: 'Engineering' },
    checkInAt: '2026-09-11T09:10:00.000Z',
    checkOutAt: '2026-09-11T18:05:00.000Z',
    workHours: '8h 55m',
    status: 'LATE',
    notes: null,
    ...over,
  });

  const envelope = (rows: any[], over: Record<string, any> = {}) => ({
    rows,
    totalMatched: rows.length,
    truncated: false,
    limit: EXPORT_MAX_ROWS,

    ...over,
  });

  it('emits a header row and one line per record', async () => {
    send.mockReturnValue(of(envelope([row()])));

    const csv = await controller.exportAttendance(
      TENANT,
      {} as any,
      res as any,
    );
    const lines = csv.split('\r\n');

    expect(lines[0]).toBe(
      'Date,Employee ID,Employee,Department,Check-in,Check-out,Work Hours,Status,Notes',
    );
    expect(lines[1]).toBe(
      '2026-09-11,EMP001,Ayesha Khan,Engineering,2026-09-11T09:10:00.000Z,2026-09-11T18:05:00.000Z,8h 55m,LATE,',
    );
    expect(lines).toHaveLength(2);
  });

  it('forwards the tenant and query to the service', async () => {
    send.mockReturnValue(of(envelope([])));

    await controller.exportAttendance(
      TENANT,
      { departmentId: 'dept-1' } as any,
      res as any,
    );

    expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.ATTENDANCE.EXPORT, {
      tenantId: TENANT,
      query: { departmentId: 'dept-1' },
    });
  });

  it('quotes values containing a comma, quote or newline', async () => {
    send.mockReturnValue(
      of(
        envelope([
          row({
            employee: { employeeCode: 'EMP002', name: 'Khan, Ali' },
            notes: 'said "late" again',
            status: 'line1\nline2',
          }),
        ]),
      ),
    );

    const csv = await controller.exportAttendance(
      TENANT,
      {} as any,
      res as any,
    );

    expect(csv).toContain('"Khan, Ali"');
    expect(csv).toContain('"said ""late"" again"');
    expect(csv).toContain('"line1\nline2"');
  });

  it('renders missing nested fields as empty rather than "undefined"', async () => {
    send.mockReturnValue(
      of(envelope([row({ employee: undefined, department: null })])),
    );

    const csv = await controller.exportAttendance(
      TENANT,
      {} as any,
      res as any,
    );

    expect(csv).not.toMatch(/undefined|\[object Object\]/);
    expect(csv.split('\r\n')[1]).toBe(
      '2026-09-11,,,,2026-09-11T09:10:00.000Z,2026-09-11T18:05:00.000Z,8h 55m,LATE,',
    );
  });

  it('returns only the header row when nothing matches', async () => {
    send.mockReturnValue(of(envelope([])));

    const csv = await controller.exportAttendance(
      TENANT,
      {} as any,
      res as any,
    );

    expect(csv.split('\r\n')).toHaveLength(1);
  });

  it('survives a service response with no envelope at all', async () => {
    send.mockReturnValue(of(undefined));

    const csv = await controller.exportAttendance(
      TENANT,
      {} as any,
      res as any,
    );

    expect(csv.split('\r\n')).toHaveLength(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-Export-Truncated', 'false');
  });

  it('sets CSV download headers', async () => {
    send.mockReturnValue(of(envelope([row()])));

    await controller.exportAttendance(TENANT, {} as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(
        /^attachment; filename="attendance-\d{4}-\d{2}-\d{2}\.csv"$/,
      ),
    );
  });

  it('reports truncation so a capped export is not mistaken for complete', async () => {
    send.mockReturnValue(
      of(envelope([row()], { totalMatched: 25000, truncated: true })),
    );

    await controller.exportAttendance(TENANT, {} as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Export-Total-Matched',
      '25000',
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Export-Truncated', 'true');
  });
});
