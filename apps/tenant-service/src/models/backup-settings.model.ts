import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';

export enum BackupFrequency {
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
}

export enum BackupLocation {
  CLOUD = 'CLOUD',
  LOCAL = 'LOCAL',
}

/**
 * Singleton row — Backups tab settings. `automaticBackupEnabled`/`frequency`/
 * `time` are stored preferences: this codebase has no scheduler (no
 * @nestjs/schedule, no cron — the same limitation BillingScheduler lives
 * with), so nothing fires a backup on a timer yet. `BACKUP.CREATE_NOW` runs a
 * real dump on demand, and `retentionDays` is applied by
 * BackupService.enforceRetention(), which is invoked from that same run.
 */
@Table({ tableName: 'backup_settings' })
export class BackupSettings extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Default(false)
  @Column
  declare automaticBackupEnabled: boolean;

  @Default(BackupFrequency.DAILY)
  @Column({ type: DataType.ENUM(...Object.values(BackupFrequency)) })
  declare frequency: BackupFrequency;

  @Default('03:00')
  @Column
  declare time: string;

  @Default(30)
  @Column
  declare retentionDays: number;

  @Default(BackupLocation.CLOUD)
  @Column({ type: DataType.ENUM(...Object.values(BackupLocation)) })
  declare location: BackupLocation;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
