import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { TenantConnectionOptions, resolveDbCredentials } from '@app/database';

export interface TenantConnectionMetrics {
  cacheSize: number;
  maxCacheSize: number;
  activeConnectionsCount: number;
  activeTenantIds: string[];
  totalConnectionsCreated: number;
  connectionFailures: number;
  evictedConnections: number;
  hitCount: number;
  missCount: number;
}

/** A PgBouncer-style pooler endpoint, which tolerates many more client connections than Postgres itself. */
const isPooledHost = (host?: string): boolean =>
  process.env.DB_POOLER === 'true' || /-pooler\./i.test(host ?? '');

@Injectable()
export class TenantConnectionManager implements OnModuleDestroy {
  private readonly logger = new Logger(TenantConnectionManager.name);
  private tenantConnections: Map<string, Sequelize> = new Map();
  private pendingConnections: Map<string, Promise<Sequelize>> = new Map();
  private lastAccessedMap: Map<string, number> = new Map();

  private maxCachedConnections: number = parseInt(
    process.env.MAX_TENANT_CONNECTIONS || '50',
    10,
  );
  private idleTimeoutMs: number = parseInt(
    process.env.TENANT_CONNECTION_IDLE_TIMEOUT_MS || '600000',
    10,
  );

  private metrics = {
    totalConnectionsCreated: 0,
    connectionFailures: 0,
    evictedConnections: 0,
    hitCount: 0,
    missCount: 0,
  };

  private idleSweepInterval?: NodeJS.Timeout;

  /**
   * Tenants with a connection currently being established. Reserves cache
   * capacity for them before they land in `tenantConnections`, so that N
   * concurrent first-requests for N different new tenants cannot all pass
   * the capacity check and overshoot `maxCachedConnections` together.
   */
  private reservedKeys: Set<string> = new Set();

  constructor() {
    // Periodically sweep idle connections every 2 minutes
    this.idleSweepInterval = setInterval(() => {
      this.evictIdleConnections().catch((err) =>
        this.logger.error(
          `Error during idle connection eviction sweep: ${err.message}`,
        ),
      );
    }, 120000);
    if (this.idleSweepInterval.unref) {
      this.idleSweepInterval.unref();
    }
  }

  setMaxCachedConnections(limit: number): void {
    this.maxCachedConnections = limit;
  }

  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = ms;
  }

  async onModuleDestroy() {
    if (this.idleSweepInterval) {
      clearInterval(this.idleSweepInterval);
    }
    await this.closeAllConnections();
  }

  /**
   * Create or retrieve dynamic connection pool for a tenant safely
   */
  async getConnection(options: TenantConnectionOptions): Promise<Sequelize> {
    const key = options.tenantId;

    if (this.tenantConnections.has(key)) {
      const conn = this.tenantConnections.get(key);
      this.lastAccessedMap.set(key, Date.now());
      // Refresh Map insertion order for LRU tracking
      this.tenantConnections.delete(key);
      this.tenantConnections.set(key, conn);
      this.metrics.hitCount++;
      return conn;
    }

    this.metrics.missCount++;

    // Prevent race conditions / duplicate connection attempts
    if (this.pendingConnections.has(key)) {
      return this.pendingConnections.get(key);
    }

    // Check cache limit (including in-flight reservations, so concurrent
    // misses for different tenants can't all pass this check and overshoot
    // maxCachedConnections before any of them finishes connecting) and evict
    // an LRU/idle connection if capacity is exceeded.
    while (
      this.tenantConnections.size + this.reservedKeys.size >=
      this.maxCachedConnections
    ) {
      const evicted = await this.evictOldestConnection();
      if (evicted) continue;

      // Nothing is evictable yet — every slot is consumed by other in-flight
      // reservations rather than an actual cached (and therefore evictable)
      // connection. Wait for one of those attempts to settle instead of
      // proceeding and overshooting the cap.
      const inFlight = Array.from(this.pendingConnections.values());
      if (inFlight.length === 0) break; // nothing to wait for
      await Promise.race(inFlight.map((p) => p.catch(() => undefined)));
    }
    this.reservedKeys.add(key);

    const connectionPromise = (async () => {
      try {
        const creds = resolveDbCredentials('tenant');
        const host = options.host || creds.host;
        const port = options.port || creds.port;
        const username = options.username || creds.username;
        const password = options.password || creds.password;
        const safeId = options.tenantId
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .toLowerCase();
        const database = options.databaseName || `hrms_${safeId}`;

        const connection = new Sequelize({
          host,
          port,
          username,
          password,
          database,
          dialect: options.dialect || 'postgres',
          dialectOptions: options.dialectOptions ?? creds.dialectOptions,
          // Opt-in: printing every statement is slow (synchronous stdout,
          // painfully so on Windows) and was on for all of development.
          logging: process.env.DB_LOG_SQL === 'true' ? (msg) => this.logger.debug(msg) : false,
          pool: {
            // Sized for the total, not for one tenant.
            //
            // This manager caches up to MAX_TENANT_CONNECTIONS pools (50 by
            // default) and both tenant-service and user-service run their
            // own manager, so the worst case is
            // `MAX_TENANT_CONNECTIONS × max × processes` sockets against
            // Postgres. At max: 5 that was 50 × 5 × 2 = 500 — comfortably
            // past the default `max_connections` of 100, at which point new
            // tenants fail to connect at all and the failure looks like a
            // database outage rather than a pool misconfiguration.
            //
            // 2 keeps the same arithmetic at 200 against a plain Postgres.
            //
            // Behind a connection pooler (PgBouncer — Neon's `-pooler`
            // hosts) the client-side limit is in the thousands, and 2 was
            // the bottleneck instead: a dashboard's ~30 parallel queries ran
            // two at a time, ~15 serial round trips. So the default is 8
            // there and 2 otherwise; TENANT_DB_POOL_MAX overrides both.
            max: parseInt(process.env.TENANT_DB_POOL_MAX || (isPooledHost(host) ? '8' : '2'), 10),
            min: parseInt(process.env.TENANT_DB_POOL_MIN || '0', 10),
            // Opening a connection (TLS + auth) costs far more than holding
            // one: at 10s idle, the extra connections a page needs were
            // closed and reopened on nearly every page load.
            idle: parseInt(process.env.TENANT_DB_POOL_IDLE_MS || '300000', 10),
            acquire: 30000,
          },
        });

        await connection.authenticate();
        this.tenantConnections.set(key, connection);
        this.lastAccessedMap.set(key, Date.now());
        this.metrics.totalConnectionsCreated++;
        this.logger.log(
          `Initialized database connection pool for tenant: ${key} (${database})`,
        );
        return connection;
      } catch (err) {
        this.metrics.connectionFailures++;
        throw err;
      } finally {
        this.pendingConnections.delete(key);
        this.reservedKeys.delete(key);
      }
    })();

    this.pendingConnections.set(key, connectionPromise);
    return connectionPromise;
  }

  /**
   * True if a tenant's connection pool currently has one or more connections
   * checked out for an in-flight query. Used to avoid evicting a pool out
   * from under a request that is actively using it.
   */
  private isConnectionBusy(connection: Sequelize): boolean {
    try {
      const pool = (connection as any)?.connectionManager?.pool;
      return typeof pool?.using === 'number' && pool.using > 0;
    } catch {
      return false;
    }
  }

  /**
   * Evict the least recently used connection that is not currently busy.
   * Falls back to evicting the oldest connection regardless of activity
   * only when every cached connection is busy (cache fully saturated with
   * active tenants), logging a warning since that eviction may disrupt an
   * in-flight query. Returns true if a connection was evicted.
   */
  async evictOldestConnection(): Promise<boolean> {
    const byAge = Array.from(this.lastAccessedMap.entries()).sort(
      (a, b) => a[1] - b[1],
    );

    let fallbackKey: string | null = null;
    for (const [key] of byAge) {
      const conn = this.tenantConnections.get(key);
      if (!conn) continue;
      if (fallbackKey === null) fallbackKey = key;
      if (!this.isConnectionBusy(conn)) {
        this.logger.log(`Evicting LRU tenant connection: ${key}`);
        await this.closeConnection(key);
        this.metrics.evictedConnections++;
        return true;
      }
    }

    if (!fallbackKey && this.tenantConnections.size > 0) {
      fallbackKey = this.tenantConnections.keys().next().value || null;
    }

    if (fallbackKey) {
      this.logger.warn(
        `All cached tenant connections are busy; force-evicting in-use connection: ${fallbackKey}`,
      );
      await this.closeConnection(fallbackKey);
      this.metrics.evictedConnections++;
      return true;
    }

    return false;
  }

  /**
   * Sweep and close connections idle for longer than threshold
   */
  async evictIdleConnections(
    thresholdMs: number = this.idleTimeoutMs,
  ): Promise<number> {
    const now = Date.now();
    const idleKeys: string[] = [];

    for (const [key, lastAccess] of this.lastAccessedMap.entries()) {
      if (now - lastAccess > thresholdMs) {
        idleKeys.push(key);
      }
    }

    for (const key of idleKeys) {
      this.logger.log(`Evicting idle tenant connection: ${key}`);
      await this.closeConnection(key);
      this.metrics.evictedConnections++;
    }

    return idleKeys.length;
  }

  /**
   * Close connection for a tenant
   */
  async closeConnection(tenantId: string): Promise<void> {
    const connection = this.tenantConnections.get(tenantId);
    if (connection) {
      try {
        await connection.close();
      } catch (err: any) {
        this.logger.error(
          `Error closing connection for tenant ${tenantId}: ${err.message}`,
        );
      }
      this.tenantConnections.delete(tenantId);
      this.lastAccessedMap.delete(tenantId);
      this.logger.log(`Closed database connection for tenant: ${tenantId}`);
    }
  }

  /**
   * Close all active tenant connections gracefully
   */
  async closeAllConnections(): Promise<void> {
    for (const [tenantId, connection] of this.tenantConnections.entries()) {
      try {
        await connection.close();
      } catch (err: any) {
        this.logger.error(
          `Error closing connection for tenant ${tenantId}: ${err.message}`,
        );
      }
    }
    this.tenantConnections.clear();
    this.pendingConnections.clear();
    this.lastAccessedMap.clear();
    this.reservedKeys.clear();
  }

  /**
   * Get active tenant connection map
   */
  getActiveConnections(): Map<string, Sequelize> {
    return this.tenantConnections;
  }

  /**
   * Get connection metrics
   */
  getMetrics(): TenantConnectionMetrics {
    return {
      cacheSize: this.tenantConnections.size,
      maxCacheSize: this.maxCachedConnections,
      activeConnectionsCount: this.tenantConnections.size,
      activeTenantIds: Array.from(this.tenantConnections.keys()),
      totalConnectionsCreated: this.metrics.totalConnectionsCreated,
      connectionFailures: this.metrics.connectionFailures,
      evictedConnections: this.metrics.evictedConnections,
      hitCount: this.metrics.hitCount,
      missCount: this.metrics.missCount,
    };
  }
}
