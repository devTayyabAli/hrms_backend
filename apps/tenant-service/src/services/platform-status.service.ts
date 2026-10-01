import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Sequelize } from 'sequelize';
import { SERVICES, MESSAGE_PATTERNS } from '@app/common';
import { TenantDatabaseConfig, BackupRecord, BackupStatus } from '../models';

export interface ServiceHealth {
  service: string;
  status: 'up' | 'down';
  uptimeSeconds: number | null;
  error?: string;
}

export interface StorageUsage {
  usedBytes: number;
  usedGB: number;
  quotaGB: number | null;
  percentageUsed: number | null;
  unmeasuredDatabases: number;
}

/** One card in the Overview tab's System Health panel. */
export interface ComponentHealth {
  component: string;
  status: 'operational' | 'degraded' | 'down';
  detail?: string;
  error?: string;
}

export interface StorageBreakdown {
  totalBytes: number;
  totalGB: number;
  categories: Array<{ name: string; bytes: number; gb: number; percentage: number }>;
}

@Injectable()
export class PlatformStatusService {
  private readonly logger = new Logger(PlatformStatusService.name);

  constructor(
    @InjectModel(TenantDatabaseConfig)
    private readonly tenantDbConfigModel: typeof TenantDatabaseConfig,
    @InjectModel(BackupRecord) private readonly backupRecordModel: typeof BackupRecord,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {}

  private async checkService(client: ClientProxy, name: string): Promise<ServiceHealth> {
    try {
      const res: any = await firstValueFrom(
        client.send(MESSAGE_PATTERNS.HEALTH.CHECK, {}).pipe(timeout(3000)),
      );
      return {
        service: name,
        status: res?.status === 'up' ? 'up' : 'down',
        uptimeSeconds: typeof res?.uptimeSeconds === 'number' ? res.uptimeSeconds : null,
      };
    } catch (err: any) {
      return { service: name, status: 'down', uptimeSeconds: null, error: err.message };
    }
  }

  /**
   * Sums `pg_database_size()` across the platform database and every
   * per-tenant database (one physical database per tenant — see
   * TenantDatabaseConfig). Tenant databases are grouped by their own
   * host/port/username, each of which already carries its own connection
   * details on the TenantDatabaseConfig row, because tenants aren't
   * guaranteed to share the platform DB's server. One throwaway connection
   * per distinct server is opened (not one per tenant) and closed
   * immediately after. A group whose connection fails is counted in
   * `unmeasuredDatabases` instead of failing the whole widget — this is a
   * live rollup for a dashboard card, not a billing-critical figure.
   */
  private async getStorageUsage(): Promise<StorageUsage> {
    const platformSequelize = this.tenantDbConfigModel.sequelize!;
    // eslint-disable-next-line no-restricted-syntax -- reads the size of the connection's own database; no dynamic/untrusted values interpolated.
    const [[platformRow]]: any = await platformSequelize.query(
      'SELECT pg_database_size(current_database()) as size;',
    );
    let usedBytes = Number(platformRow?.size || 0);

    const tenantDbConfigs = await this.tenantDbConfigModel.findAll();
    const groups = new Map<
      string,
      { host: string; port: number; username: string; password: string; databaseNames: string[] }
    >();
    for (const config of tenantDbConfigs) {
      const key = `${config.host}:${config.port}:${config.username}`;
      const group = groups.get(key);
      if (group) {
        group.databaseNames.push(config.databaseName);
      } else {
        groups.set(key, {
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          databaseNames: [config.databaseName],
        });
      }
    }

    let unmeasuredDatabases = 0;
    for (const group of groups.values()) {
      const sequelize = new Sequelize({
        host: group.host,
        port: group.port,
        username: group.username,
        password: group.password,
        // Connect to one of the group's own tenant databases (guaranteed to
        // exist for these credentials) rather than a "postgres" maintenance
        // database, which some managed Postgres providers don't expose.
        database: group.databaseNames[0],
        dialect: 'postgres',
        // Mirrors the SSL detection in resolveDbCredentials() (@app/database)
        // — managed providers like Neon reject plaintext connections outright,
        // and a tenant DB's host isn't necessarily the platform DB's host, so
        // that helper's env-driven check can't be reused as-is here.
        dialectOptions: group.host.includes('neon.tech')
          ? { ssl: { require: true, rejectUnauthorized: process.env.NODE_ENV === 'production' } }
          : undefined,
        logging: false,
      });
      try {
        // Sequelize expands an array-valued named replacement into a
        // comma-separated literal list (for `IN (:names)`), not a Postgres
        // array — `= ANY(:names)` would emit invalid SQL like `ANY('a', 'b')`.
        // eslint-disable-next-line no-restricted-syntax -- database names are bound via `replacements`, never interpolated.
        const [rows]: any = await sequelize.query(
          'SELECT datname, pg_database_size(datname) as size FROM pg_database WHERE datname IN (:names);',
          { replacements: { names: group.databaseNames } },
        );
        const measured = new Set<string>();
        for (const row of rows || []) {
          usedBytes += Number(row.size || 0);
          measured.add(row.datname);
        }
        unmeasuredDatabases += group.databaseNames.filter((name) => !measured.has(name)).length;
      } catch (err: any) {
        this.logger.warn(
          `Could not measure storage for databases on ${group.host}:${group.port}: ${err.message}`,
        );
        unmeasuredDatabases += group.databaseNames.length;
      } finally {
        await sequelize.close();
      }
    }

    const usedGB = Math.round((usedBytes / 1024 ** 3) * 100) / 100;
    const quotaGBRaw = this.configService.get<string>('PLATFORM_STORAGE_QUOTA_GB');
    const quotaGB = quotaGBRaw ? Number(quotaGBRaw) : null;

    return {
      usedBytes,
      usedGB,
      quotaGB,
      percentageUsed: quotaGB ? Math.round((usedGB / quotaGB) * 1000) / 10 : null,
      unmeasuredDatabases,
    };
  }

  /** Live reachability of the platform database itself. */
  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      // eslint-disable-next-line no-restricted-syntax -- trivial connectivity probe; no model, no interpolated values.
      await this.tenantDbConfigModel.sequelize!.query('SELECT 1;');
      return { component: 'Database', status: 'operational' };
    } catch (err: any) {
      return { component: 'Database', status: 'down', error: err.message };
    }
  }

  /** Live SMTP verification via auth-service's MailService. */
  private async checkEmail(): Promise<ComponentHealth> {
    try {
      const ok: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.MAIL.VERIFY_CONNECTION, {}).pipe(timeout(5000)),
      );
      return { component: 'Email Services', status: ok ? 'operational' : 'down' };
    } catch (err: any) {
      return { component: 'Email Services', status: 'down', error: err.message };
    }
  }

  /** Live check of the configured file-storage backend. */
  private async checkFileStorage(): Promise<ComponentHealth> {
    try {
      const res: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.FILE.CHECK_HEALTH, {}).pipe(timeout(5000)),
      );
      return {
        component: 'File Storage',
        status: res?.status === 'up' ? 'operational' : 'down',
        detail: res?.provider,
        error: res?.error,
      };
    } catch (err: any) {
      return { component: 'File Storage', status: 'down', error: err.message };
    }
  }

  /**
   * Storage split by the categories the Overview tab shows. Database and log
   * sizes come from Postgres directly; file and backup sizes come from
   * auth-service, which owns the file-metadata records.
   */
  private async getStorageBreakdown(databaseBytes: number): Promise<StorageBreakdown> {
    let filesBytes = 0;
    let backupsBytes = 0;
    try {
      const res: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.FILE.GET_STORAGE_BREAKDOWN, {}).pipe(timeout(5000)),
      );
      filesBytes = Number(res?.filesBytes) || 0;
      backupsBytes = Number(res?.backupsBytes) || 0;
    } catch (err: any) {
      this.logger.warn(`Could not read file storage breakdown: ${err.message}`);
    }

    // Audit logs live in the platform database, so their size is already
    // inside `databaseBytes`; it's broken out here as its own "Logs" category
    // and subtracted so the categories don't double-count.
    let logsBytes = 0;
    try {
      // eslint-disable-next-line no-restricted-syntax -- pg_total_relation_size has no model; static identifier, no interpolated values.
      const [[row]]: any = await this.tenantDbConfigModel.sequelize!.query(
        `SELECT pg_total_relation_size('audit_logs') AS size;`,
      );
      logsBytes = Number(row?.size) || 0;
    } catch (err: any) {
      this.logger.warn(`Could not measure audit log storage: ${err.message}`);
    }

    const databaseOnlyBytes = Math.max(0, databaseBytes - logsBytes);
    const totalBytes = databaseOnlyBytes + logsBytes + filesBytes + backupsBytes;
    const pct = (bytes: number) => (totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0);
    const toGB = (bytes: number) => Math.round((bytes / 1024 ** 3) * 100) / 100;

    return {
      totalBytes,
      totalGB: toGB(totalBytes),
      categories: [
        { name: 'Files & Documents', bytes: filesBytes, gb: toGB(filesBytes), percentage: pct(filesBytes) },
        { name: 'Database', bytes: databaseOnlyBytes, gb: toGB(databaseOnlyBytes), percentage: pct(databaseOnlyBytes) },
        { name: 'Backups', bytes: backupsBytes, gb: toGB(backupsBytes), percentage: pct(backupsBytes) },
        { name: 'Logs', bytes: logsBytes, gb: toGB(logsBytes), percentage: pct(logsBytes) },
      ],
    };
  }

  /** Timestamp of the most recent successful backup, or null if there is none. */
  private async getLastBackupAt(): Promise<Date | null> {
    const latest = await this.backupRecordModel.findOne({
      where: { status: BackupStatus.SUCCESS },
      order: [['completedAt', 'DESC']],
    });
    return latest?.completedAt || null;
  }

  /**
   * Platform Status + System Health + Storage Overview for the SuperAdmin
   * dashboards. Everything here is measured live except `uptimePercentage`
   * and `activeIntegrations`, which are returned as `null` with an
   * explanation rather than a fabricated number.
   */
  async getStatus() {
    const [authHealth, userHealth, storage, dbHealth, emailHealth, storageHealth, lastBackupAt] =
      await Promise.all([
        this.checkService(this.authClient, 'auth-service'),
        this.checkService(this.userClient, 'user-service'),
        this.getStorageUsage(),
        this.checkDatabase(),
        this.checkEmail(),
        this.checkFileStorage(),
        this.getLastBackupAt(),
      ]);
    const tenantHealth: ServiceHealth = {
      service: 'tenant-service',
      status: 'up',
      uptimeSeconds: process.uptime(),
    };

    const services = { auth: authHealth, tenant: tenantHealth, user: userHealth };
    const downCount = Object.values(services).filter((s) => s.status === 'down').length;
    const systemStatus =
      downCount === 0 ? 'operational' : downCount === Object.keys(services).length ? 'down' : 'degraded';

    // The five cards the Overview tab renders. "API Services" reflects the
    // microservice mesh as a whole; the rest are individually probed.
    const apiStatus = downCount === 0 ? 'operational' : 'degraded';
    const components: ComponentHealth[] = [
      { component: 'Platform Status', status: systemStatus === 'operational' ? 'operational' : 'degraded' },
      { component: 'API Services', status: apiStatus },
      dbHealth,
      storageHealth,
      emailHealth,
    ];
    const allOperational = components.every((c) => c.status === 'operational');

    const breakdown = await this.getStorageBreakdown(storage.usedBytes);

    return {
      systemStatus,
      systemHealth: {
        summary: allOperational ? 'All Systems Operational' : 'Degraded — one or more components need attention',
        allOperational,
        components,
      },
      services,
      uptimePercentage: null,
      storage,
      storageOverview: breakdown,
      activeIntegrations: null,
      lastBackupAt,
      notes: {
        uptimePercentage:
          'Requires a persisted uptime-monitoring subsystem (e.g. Prometheus/Pingdom); not yet implemented. `systemStatus` and `systemHealth.components` reflect live health instead.',
        activeIntegrations:
          'No integrations subsystem exists in this codebase yet — needs a dedicated model/table before this can be real.',
      },
      links: { systemHealth: '/health/detailed' },
    };
  }
}
