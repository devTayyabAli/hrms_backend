import { BadRequestException, Logger } from '@nestjs/common';
import { Model, Sequelize } from 'sequelize-typescript';
import { bindModelsToConnection } from '@app/database';
import { TenantConnectionManager } from '../context/tenant-connection.manager';
import { TenantContextService } from '../context/tenant-context.service';

/**
 * Shared machinery for resolving a tenant's own physical database and binding
 * a service's models onto it.
 *
 * tenant-service and user-service each had their own copy of this: the same
 * tenant resolution, the same connection-identity cache, the same
 * `bindModelsToConnection` call and the same `sync()` gate, differing only in
 * which model classes they register and whether they attach audit hooks
 * afterwards.
 *
 * Duplication matters more than usual here because the logic is subtle in two
 * places, and a copy that drifts on either is a correctness bug rather than a
 * style problem:
 *
 *   - the connection-identity check that keeps preparation to once per
 *     *connection* (not once per call) while still re-preparing when the
 *     manager hands back a new one, and
 *   - `bindModelsToConnection`, which is what stops one tenant's model handles
 *     being silently repointed at another tenant's database.
 *
 * Subclasses supply the model list and, optionally, an `onConnectionPrepared`
 * hook for anything that must run exactly once per connection instance.
 *
 * Subclasses MUST stay singleton-scoped. `connectionsMap` is what keeps that
 * preparation to once per tenant per process, and Nest bubbles scope up the
 * injection graph — injecting any REQUEST-scoped provider into a subclass
 * would silently make it request-scoped, giving every message a fresh
 * instance and an empty cache, re-running the preparation each time and (for
 * providers that register hooks) stacking another set onto the genuinely
 * shared connection every request.
 */
export abstract class BaseTenantModelProvider {
  protected readonly logger: Logger;
  private readonly connectionsMap = new Map<string, Sequelize>();
  private static readonly syncedTenants = new Set<string>();

  public static markTenantSynced(tenantId: string): void {
    BaseTenantModelProvider.syncedTenants.add(tenantId);
  }

  constructor(
    protected readonly tenantContextService: TenantContextService,
    protected readonly connectionManager: TenantConnectionManager,
    loggerContext: string,
  ) {
    this.logger = new Logger(loggerContext);
  }

  /**
   * Model classes to register on each tenant connection.
   *
   * Order matters: `sync()` creates tables in registration order and these
   * models carry real foreign keys, so a referenced table has to be listed
   * before the table referencing it.
   */
  protected abstract get models(): Array<typeof Model>;

  /**
   * Called once per newly prepared connection instance, after models are
   * bound. Override for per-connection setup such as hook registration.
   *
   * Runs exactly once per connection because `getConnection` only reaches it
   * for a connection this provider has not seen before — which is what keeps
   * `addHook` (which appends) from stacking duplicate hooks and writing two
   * audit rows per change, then three, and so on.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onConnectionPrepared(connection: Sequelize): void {
    // No-op by default; overridden where per-connection setup is needed.
  }

  /**
   * Resolve the active Sequelize connection for the given tenant.
   *
   * Pass `tenantId` explicitly whenever it is known (e.g. from a signed
   * microservice payload or a controller argument) rather than relying on
   * ambient context. `TenantRequestContextService` is deliberately NOT
   * consulted here: it is only ever populated by TenantResolverMiddleware,
   * Express middleware that never runs in a TCP microservice (these handlers
   * run in a separate process from the gateway that resolved the request), so
   * it could only ever return undefined — while making the provider
   * request-scoped at the cost of the connection cache.
   */
  async getConnection(tenantId?: string): Promise<Sequelize> {
    let resolvedTenantId = tenantId;

    if (!resolvedTenantId) {
      resolvedTenantId = this.tenantContextService.getTenantId();
    }

    if (!resolvedTenantId) {
      throw new BadRequestException(
        'Missing tenant context. This operation requires an explicit tenantId.',
      );
    }

    // Always resolve through the connection manager (a cheap in-memory map
    // hit) rather than trusting a connection cached here indefinitely: the
    // manager owns connection lifetime and closes connections behind our back
    // — on idle sweep, on LRU eviction, on shutdown. A connection memoized
    // here would keep being handed out after it was closed, and every query
    // on it would fail instantly. Comparing instance identity keeps the
    // expensive preparation below to once per *connection* while
    // re-preparing automatically whenever the manager hands back a new one.
    const connection = await this.connectionManager.getConnection({
      tenantId: resolvedTenantId,
    });
    if (this.connectionsMap.get(resolvedTenantId) === connection) {
      return connection;
    }

    // Bind per-connection subclasses rather than `connection.addModels([...])`
    // directly — the latter mutates these shared decorated classes' static
    // `sequelize` property in place, so registering them again for the next
    // tenant's connection would silently repoint every previously cached
    // tenant's model handle (this one included) at that other tenant's
    // database. See bindModelsToConnection() for the full explanation.
    bindModelsToConnection(this.models, connection);
    await this.syncIfEnabled(connection, resolvedTenantId);
    this.onConnectionPrepared(connection);
    this.connectionsMap.set(resolvedTenantId, connection);
    return connection;
  }

  /**
   * Run `sync()` only when schema auto-management is enabled.
   *
   * `sync()` issues a `pg_catalog` describe per model, so it costs one round
   * trip per table on every cold connection — and because
   * TenantConnectionManager evicts on LRU and idle sweep, "cold" recurs
   * routinely in normal operation rather than only at startup. Across a
   * platform of tenants that is the single largest avoidable cost on the
   * request path, and it is schema migration happening implicitly under live
   * traffic, which is a correctness risk independent of the latency.
   *
   * Defaults off in production and on elsewhere, so existing dev and test
   * setups keep working untouched. Production schema must be created at
   * provisioning time or by a migration run; set TENANT_DB_AUTO_SYNC=true to
   * opt back in deliberately.
   */
  protected async syncIfEnabled(
    connection: Sequelize,
    tenantId: string,
  ): Promise<void> {
    if (BaseTenantModelProvider.syncedTenants.has(tenantId)) {
      return;
    }

    const flag = process.env.TENANT_DB_AUTO_SYNC;
    const enabled =
      flag !== undefined
        ? flag === 'true'
        : process.env.NODE_ENV !== 'production';

    if (!enabled) {
      return;
    }

    const startedAt = Date.now();
    await connection.sync({ force: false });
    BaseTenantModelProvider.syncedTenants.add(tenantId);
    this.logger.debug(
      `Schema sync for tenant ${tenantId} took ${Date.now() - startedAt}ms`,
    );
  }

  /** Convenience for the `getXModel()` accessors every subclass exposes. */
  protected async model<T>(name: string, tenantId?: string): Promise<T> {
    const connection = await this.getConnection(tenantId);
    return connection.models[name] as unknown as T;
  }
}
