import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Transaction } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';
import {
  DirectoryPayload,
  DirectorySourceType,
  ProjectionEventType,
  categorizeRoleName,
  emitProjectionEvent,
  emitProjectionEvents,
} from '@app/database';
import { TenantModelProviderService } from './tenant-model-provider.service';

const APPLY_TIMEOUT_MS = 5000;

/**
 * Publishes user changes to the SuperAdmin directory projection.
 *
 * Two steps, in this order and for a reason:
 *
 * 1. Queue the event in the tenant's own outbox, inside the caller's
 *    transaction. This is the durable part — once the domain write commits,
 *    the event is committed with it and cannot be lost.
 * 2. After the commit, ask tenant-service to apply it immediately so the
 *    SuperAdmin list is current within milliseconds rather than within a
 *    relay interval. This call is allowed to fail; the relay is the
 *    guarantee, this is only the latency optimisation.
 *
 * user-service cannot write the projection itself — it has no connection to
 * the platform database — which is why step 2 is an RPC and why
 * tenant-service stays the projection's only writer.
 */
@Injectable()
export class DirectoryEmitterService {
  private readonly logger = new Logger(DirectoryEmitterService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  /** Flattens a user row (with roles loaded) into the projection's columns. */
  payloadFor(user: any): DirectoryPayload {
    const primaryRole = user.roles?.[0];
    return {
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      email: user.email,
      phone: user.phone ?? null,
      department: user.department ?? null,
      role: primaryRole?.name ?? null,
      roleCategory: categorizeRoleName(primaryRole?.name),
      isActive: user.isActive ?? true,
      sourceCreatedAt: user.createdAt ?? null,
      sourceUpdatedAt: user.updatedAt ?? null,
    };
  }

  async emitUpsert(
    tenantId: string,
    user: any,
    eventType: ProjectionEventType,
    transaction?: Transaction,
  ): Promise<void> {
    const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
    await emitProjectionEvent(
      Outbox,
      {
        tenantId,
        aggregateType: DirectorySourceType.USER,
        aggregateId: user.id,
        eventType,
        payload: this.payloadFor(user),
      },
      transaction,
    );
  }

  async emitDelete(
    tenantId: string,
    userId: string,
    transaction?: Transaction,
  ): Promise<void> {
    const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
    await emitProjectionEvent(
      Outbox,
      {
        tenantId,
        aggregateType: DirectorySourceType.USER,
        aggregateId: userId,
        eventType: ProjectionEventType.DELETED,
        payload: null,
      },
      transaction,
    );
  }

  /** One event per id — a bulk delete that emits once loses the rest. */
  async emitDeletes(
    tenantId: string,
    userIds: string[],
    transaction?: Transaction,
  ): Promise<void> {
    const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
    await emitProjectionEvents(
      Outbox,
      userIds.map((userId) => ({
        tenantId,
        aggregateType: DirectorySourceType.USER,
        aggregateId: userId,
        eventType: ProjectionEventType.DELETED,
        payload: null,
      })),
      transaction,
    );
  }

  /**
   * Drains this tenant's freshly queued events to the projection.
   *
   * Call AFTER the transaction has committed — the events are not visible to
   * another connection before that. Never throws: the outbox row is already
   * durable, so the worst case is that the SuperAdmin list lags by one relay
   * interval, which is not worth failing a user creation over.
   */
  async flush(tenantId: string): Promise<void> {
    try {
      const Outbox = await this.modelProvider.getProjectionOutboxModel(tenantId);
      const rows = await Outbox.findAll({
        where: { processedAt: null },
        order: [['occurredAt', 'ASC']],
        limit: 100,
      });
      if (!rows.length) return;

      await firstValueFrom(
        this.tenantClient
          .send(MESSAGE_PATTERNS.PROJECTION.APPLY, {
            events: (rows as any[]).map((row) => ({
              tenantId,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              eventType: row.eventType,
              version: row.version,
              payload: row.payload,
            })),
          })
          .pipe(timeout(APPLY_TIMEOUT_MS)),
      );

      await Outbox.update(
        { processedAt: new Date() },
        { where: { id: (rows as any[]).map((row) => row.id) } },
      );
    } catch (error: any) {
      this.logger.warn(
        `Directory projection not applied inline for tenant ${tenantId}; the relay will retry: ${
          error?.message ?? error
        }`,
      );
      // Tell the relay to visit this tenant rather than waiting for the
      // hourly sweep to notice.
      await this.signalPending(tenantId);
    }
  }

  private async signalPending(tenantId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.tenantClient
          .send(MESSAGE_PATTERNS.PROJECTION.APPLY, { events: [], markPending: tenantId })
          .pipe(timeout(APPLY_TIMEOUT_MS)),
      );
    } catch {
      // If tenant-service is unreachable the signal cannot be written either.
      // The hourly full sweep is the backstop for exactly this case.
    }
  }
}
