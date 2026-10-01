import { Response } from 'express';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { CsvColumn, ExportResult, csvFilename, toCsv } from '@app/common';

/**
 * Runs one CSV export end to end: call the owning service, serialize the rows,
 * and set the response headers the download depends on.
 *
 * Every Export button in the gateway followed the same seven-line recipe —
 * send the pattern, `toCsv` the rows, write `X-Export-Total-Matched`,
 * `X-Export-Truncated`, `Content-Type` and `Content-Disposition`, return the
 * string. Only the pattern, the payload and the column list ever differed.
 *
 * That shape being copied is not itself the problem; the problem is that two
 * of those headers are the *only* signal that an export was capped at
 * EXPORT_MAX_ROWS. A copy that omitted them would hand the user a CSV that
 * looks complete and silently is not, and nothing in a review would catch it.
 * Centralizing means truncation reporting cannot be forgotten by a new export.
 */
export async function sendCsvExport<T>(
  res: Response,
  client: ClientProxy,
  pattern: string,
  payload: unknown,
  filenamePrefix: string,
  columns: CsvColumn<T>[],
): Promise<string> {
  const result: ExportResult<T> = await firstValueFrom(
    client.send(pattern, payload),
  );

  const csv = toCsv(result?.rows ?? [], columns);

  // A capped export is reported in headers rather than silently handing back
  // a CSV that looks complete.
  res.setHeader('X-Export-Total-Matched', String(result?.totalMatched ?? 0));
  res.setHeader('X-Export-Truncated', String(Boolean(result?.truncated)));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${csvFilename(filenamePrefix)}"`,
  );
  return csv;
}
