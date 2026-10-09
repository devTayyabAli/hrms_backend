import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Sequelize } from 'sequelize';
import { Op } from 'sequelize';
import { gzipSync } from 'zlib';
import { SERVICES, MESSAGE_PATTERNS, UpdateBackupSettingsDto, GetBackupsQueryDto, localClock, utcOffsetMinutes } from '@app/common';
import { BackupSettings, BackupRecord, BackupStatus, TenantDatabaseConfig } from '../models';
import { BackupFrequency } from '../models/backup-settings.model';

/** How often the schedule is checked. */
const SCHEDULE_CHECK_MS = 5 * 60_000;
/** A backup still "in progress" after this long was cut off by a restart. */
const STALE_RUN_MS = 2 * 60 * 60_000;

/**
 * The most recent moment a scheduled backup was due: today's (or this
 * Monday's, or the 1st's) backup time in the platform time zone, else the
 * one before it. A backup is owed when none has run since this moment.
 */
export const latestBackupSlot = (frequency: string, time: string, now: Date, offsetMinutes: number): Date => {
  const [h, m] = (time || '02:00').split(':').map(Number);
  const slotMinutes = (h || 0) * 60 + (m || 0);
  const clock = localClock(now, offsetMinutes);
  const day = 86_400_000;
  const at = (dayStart: Date) => new Date(dayStart.getTime() + slotMinutes * 60_000);

  if (frequency === BackupFrequency.WEEKLY) {
    let daysBack = (clock.weekday - 1 + 7) % 7; // Monday
    if (daysBack === 0 && clock.minutes < slotMinutes) daysBack = 7;
    return at(new Date(clock.dayStart.getTime() - daysBack * day));
  }
  if (frequency === BackupFrequency.MONTHLY) {
    const local = new Date(now.getTime() + offsetMinutes * 60_000);
    const firstThisMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMinutes * 60_000);
    const due = at(firstThisMonth);
    if (now >= due) return due;
    return at(new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - offsetMinutes * 60_000));
  }
  const today = at(clock.dayStart);
  return now >= today ? today : new Date(today.getTime() - day);
};

/**
 * A table larger than this fails the whole backup rather than being silently
 * truncated — a backup that reports SUCCESS while quietly dropping rows is
 * worse than no backup at all. Hitting this means the platform has outgrown
 * an in-process logical dump and needs real `pg_dump` infrastructure.
 */
const MAX_ROWS_PER_TABLE = 50_000;

interface DatabaseDump {
  [tableName: string]: unknown[];
}

@Injectable()
export class BackupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupService.name);
  private scheduler: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectModel(BackupSettings) private readonly settingsModel: typeof BackupSettings,
    @InjectModel(BackupRecord) private readonly recordModel: typeof BackupRecord,
    @InjectModel(TenantDatabaseConfig)
    private readonly tenantDbConfigModel: typeof TenantDatabaseConfig,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    // A run cut off by a restart would read "in progress" forever.
    void this.recordModel
      .update(
        { status: BackupStatus.FAILED, errorMessage: 'Interrupted by a service restart.', completedAt: new Date() },
        { where: { status: BackupStatus.IN_PROGRESS, startedAt: { [Op.lt]: new Date(Date.now() - 60_000) } } },
      )
      .catch((error) => this.logger.warn(`Could not close interrupted backups: ${error?.message ?? error}`));
    this.scheduler = setInterval(() => void this.runScheduled(), SCHEDULE_CHECK_MS);
    this.scheduler.unref?.();
  }

  onModuleDestroy() {
    if (this.scheduler) clearInterval(this.scheduler);
  }

  /** Automatic backups: runs one when the configured slot has passed with no backup since. */
  async runScheduled(now = new Date()): Promise<BackupRecord | null> {
    try {
      const settings = await this.getOrCreateSettings();
      if (!settings.automaticBackupEnabled) return null;
      const offset = utcOffsetMinutes(process.env.NOTIFICATIONS_DEFAULT_TIME_ZONE, now);
      const slot = latestBackupSlot(settings.frequency, settings.time, now, offset);
      const since = await this.recordModel.count({
        where: { createdAt: { [Op.gte]: slot }, status: { [Op.in]: [BackupStatus.SUCCESS, BackupStatus.IN_PROGRESS] } },
      });
      if (since > 0) return null;
      this.logger.log(`Scheduled ${settings.frequency.toLowerCase()} backup is due (slot ${slot.toISOString()}).`);
      return await this.startBackup('schedule');
    } catch (error: any) {
      if (!(error instanceof ConflictException)) this.logger.error(`Scheduled backup check failed: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * Starts a backup and returns at once with the in-progress record; the dump
   * runs in the background. Run inside the request it outlived the reverse
   * proxy's 60s timeout on any real dataset. One backup at a time.
   */
  async startBackup(triggeredBy?: string): Promise<BackupRecord> {
    const running = await this.recordModel.findOne({
      where: { status: BackupStatus.IN_PROGRESS, startedAt: { [Op.gte]: new Date(Date.now() - STALE_RUN_MS) } },
    });
    if (running || this.running) {
      throw new ConflictException('A backup is already running. Wait for it to finish before starting another.');
    }
    this.running = true;
    const record = await this.recordModel.create({
      type: 'FULL',
      status: BackupStatus.IN_PROGRESS,
      triggeredBy: triggeredBy || 'superadmin',
      startedAt: new Date(),
    });
    void this.runBackup(record).finally(() => {
      this.running = false;
    });
    return record;
  }

  // ==========================================
  // SETTINGS
  // ==========================================

  private async getOrCreateSettings(): Promise<BackupSettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) return existing;
    return this.settingsModel.create({});
  }

  async getSettings(): Promise<BackupSettings> {
    return this.getOrCreateSettings();
  }

  async updateSettings(dto: UpdateBackupSettingsDto): Promise<BackupSettings> {
    const settings = await this.getOrCreateSettings();
    await settings.update(dto);
    return settings;
  }

  // ==========================================
  // DUMP EXECUTION
  // ==========================================

  /**
   * Postgres identifiers can't be bound as query parameters, so every table
   * name reaching a raw SELECT is allow-list checked here. Names come from
   * information_schema (i.e. from the database itself), but this keeps the
   * injection defense at the point of use rather than assuming the source.
   */
  private assertSafeIdentifier(identifier: unknown): asserts identifier is string {
    // The typeof check is load-bearing: `/regex/.test(undefined)` coerces to
    // the *string* "undefined", which would sail past the pattern and reach a
    // raw query as a bogus table name.
    if (typeof identifier !== 'string' || !/^[A-Za-z0-9_]+$/.test(identifier)) {
      throw new Error(`Refusing to read from an unsafe table identifier: "${String(identifier)}"`);
    }
  }

  private async dumpDatabase(connection: Sequelize, label: string): Promise<DatabaseDump> {
    // Deliberately pg_catalog.pg_tables rather than information_schema.tables:
    // Sequelize recognises the latter as a "show tables" query and rewrites the
    // result into a bare list with no [rows, metadata] wrapper, so the usual
    // destructure silently yields just the first table. pg_tables returns the
    // ordinary shape.
    // eslint-disable-next-line no-restricted-syntax -- pg_catalog has no model; static query, no interpolated values.
    const [tableRows]: any = await connection.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;`,
    );

    // Normalised defensively so a future dialect/version change in row shape
    // fails the identifier guard loudly instead of dumping the wrong thing.
    const tableNames: unknown[] = (tableRows || []).map((row: any) =>
      typeof row === 'string' ? row : row?.tablename ?? row?.table_name,
    );

    const dump: DatabaseDump = {};
    for (const tableName of tableNames) {
      this.assertSafeIdentifier(tableName);

      // eslint-disable-next-line no-restricted-syntax -- table identifier can't be bound as a parameter; validated by assertSafeIdentifier() above.
      const [countRows]: any = await connection.query(`SELECT COUNT(*)::int AS count FROM "${tableName}";`);
      const rowCount: number = countRows?.[0]?.count ?? 0;
      if (rowCount > MAX_ROWS_PER_TABLE) {
        throw new Error(
          `Table "${tableName}" in ${label} has ${rowCount} rows, above the ${MAX_ROWS_PER_TABLE}-row limit for in-process logical backups. ` +
            `Use dedicated pg_dump-based backup infrastructure for a dataset this size.`,
        );
      }

      // eslint-disable-next-line no-restricted-syntax -- table identifier can't be bound as a parameter; validated by assertSafeIdentifier() above.
      const [dataRows]: any = await connection.query(`SELECT * FROM "${tableName}";`);
      dump[tableName] = dataRows || [];
    }

    return dump;
  }

  /**
   * Dumps the platform database plus every provisioned tenant database into
   * one gzipped JSON artifact and stores it through the platform's file
   * storage service (S3 or local disk, per STORAGE_PROVIDER).
   *
   * This is a *logical* dump (schema-less: table name → rows), not a native
   * `pg_dump` archive — the runtime has no `pg_dump` binary available, and
   * requiring one would tie backups to a Postgres client install in every
   * deployment image. The tradeoff: portable and verifiable in-process, but
   * it captures data rather than full DDL, and it inherits the file storage
   * service's 10MB per-file ceiling (compressed).
   */
  private async runBackup(record: BackupRecord): Promise<BackupRecord> {
    try {
      const databases: Record<string, DatabaseDump> = {};

      const platformConnection = this.settingsModel.sequelize!;
      // eslint-disable-next-line no-restricted-syntax -- reads the connection's own database name; no interpolated values.
      const [[platformNameRow]]: any = await platformConnection.query('SELECT current_database() AS name;');
      const platformDbName: string = platformNameRow?.name || 'platform';
      databases[platformDbName] = await this.dumpDatabase(platformConnection, platformDbName);

      const tenantConfigs = await this.tenantDbConfigModel.findAll();
      for (const config of tenantConfigs) {
        const connection = new Sequelize({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          database: config.databaseName,
          dialect: 'postgres',
          // Same SSL detection as resolveDbCredentials() (@app/database) —
          // managed providers like Neon reject plaintext connections.
          dialectOptions: config.host.includes('neon.tech')
            ? { ssl: { require: true, rejectUnauthorized: process.env.NODE_ENV === 'production' } }
            : undefined,
          logging: false,
        });
        try {
          databases[config.databaseName] = await this.dumpDatabase(connection, config.databaseName);
        } finally {
          await connection.close();
        }
      }

      const payload = {
        format: 'hrms-logical-json-v1',
        createdAt: new Date().toISOString(),
        databases,
      };
      const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
      const filename = `hrms-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;

      const uploadResult: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
          file: {
            buffer: compressed,
            originalname: filename,
            mimetype: 'application/gzip',
            size: compressed.length,
          },
          tenantId: 'platform',
          uploadedBy: record.triggeredBy || 'superadmin',
          category: 'backups',
          entityType: 'BackupRecord',
          entityId: record.id,
          isPublic: false,
        }),
      );

      await record.update({
        status: BackupStatus.SUCCESS,
        sizeBytes: compressed.length,
        fileId: uploadResult?.data?.id || null,
        databaseCount: Object.keys(databases).length,
        completedAt: new Date(),
      });

      await this.enforceRetention();
      return record;
    } catch (err: any) {
      this.logger.error(`Backup ${record.id} failed: ${err.message}`);
      await record.update({
        status: BackupStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
      return record;
    }
  }

  // ==========================================
  // LEDGER
  // ==========================================

  async listBackups(query: GetBackupsQueryDto) {
    const page = query?.page && query.page > 0 ? query.page : 1;
    const limit = query?.limit && query.limit > 0 ? query.limit : 10;

    const { rows, count } = await this.recordModel.findAndCountAll({
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * limit,
      limit,
    });

    return { data: rows, total: count, page, limit, totalPages: Math.ceil(count / limit) || 1 };
  }

  async getBackup(id: string): Promise<BackupRecord> {
    const record = await this.recordModel.findByPk(id);
    if (!record) {
      throw new NotFoundException(`Backup ${id} not found.`);
    }
    return record;
  }

  async deleteBackup(id: string): Promise<{ success: boolean }> {
    const record = await this.getBackup(id);
    await this.deleteStoredFile(record);
    await record.destroy();
    return { success: true };
  }

  /**
   * Deletes the stored dump for a record, tolerating a missing/already-gone
   * file so a storage-side inconsistency can't block removing the row.
   */
  private async deleteStoredFile(record: BackupRecord): Promise<void> {
    if (!record.fileId) return;
    try {
      await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.FILE.DELETE_FILE, {
          fileId: record.fileId,
          userTenantId: 'platform',
        }),
      );
    } catch (err: any) {
      this.logger.warn(`Could not delete stored backup file ${record.fileId}: ${err.message}`);
    }
  }

  /** Applies `retentionDays` from settings, after every successful backup. */
  async enforceRetention(): Promise<{ deleted: number }> {
    const settings = await this.getOrCreateSettings();
    const cutoff = new Date(Date.now() - settings.retentionDays * 86400000);

    const expired = await this.recordModel.findAll({ where: { createdAt: { [Op.lt]: cutoff } } });
    for (const record of expired) {
      await this.deleteStoredFile(record);
      await record.destroy();
    }

    if (expired.length > 0) {
      this.logger.log(`Retention: removed ${expired.length} backup(s) older than ${settings.retentionDays} days.`);
    }
    return { deleted: expired.length };
  }
}
