import { Transaction } from 'sequelize';
import {
  DirectoryPayload,
  DirectorySourceType,
  ProjectionEventType,
  ProjectionOutbox,
} from '../models';

export interface EmitProjectionEventInput {
  tenantId: string;
  aggregateType: DirectorySourceType;
  aggregateId: string;
  eventType: ProjectionEventType;
  payload?: DirectoryPayload | null;
  /** Defaults to now in milliseconds, which is monotonic enough to order applies. */
  version?: number;
}

/**
 * Queues one projection event.
 *
 * **Always pass the transaction that wrote the domain row.** Without it the
 * insert commits separately and the guarantee this table exists for is gone:
 * a crash in between leaves a row the directory never hears about, and the
 * only thing that notices is the nightly reconciliation — a day later.
 *
 * The model is passed in rather than imported because it must be bound to the
 * caller's tenant connection; there is one of these tables per tenant
 * database, not one globally.
 */
export async function emitProjectionEvent(
  outboxModel: typeof ProjectionOutbox,
  input: EmitProjectionEventInput,
  transaction?: Transaction,
): Promise<void> {
  await outboxModel.create(
    {
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload ?? null,
      version: String(input.version ?? Date.now()),
      occurredAt: new Date(),
    },
    { transaction },
  );
}

/**
 * Queues one event per id in a bulk operation.
 *
 * Bulk delete is the easiest place to lose rows from the projection: deleting
 * fifty employees and emitting nothing leaves fifty ghosts on the SuperAdmin
 * list until reconciliation runs.
 */
export async function emitProjectionEvents(
  outboxModel: typeof ProjectionOutbox,
  inputs: EmitProjectionEventInput[],
  transaction?: Transaction,
): Promise<void> {
  if (!inputs.length) return;
  const now = Date.now();
  await outboxModel.bulkCreate(
    inputs.map((input, index) => ({
      tenantId: input.tenantId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload ?? null,
      // Distinct, increasing versions so two events for the same row in one
      // batch cannot be reordered by an equal version.
      version: String(input.version ?? now + index),
      occurredAt: new Date(),
    })) as any,
    { transaction },
  );
}
