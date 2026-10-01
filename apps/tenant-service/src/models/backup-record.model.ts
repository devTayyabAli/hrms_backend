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

export enum BackupStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

/** One row per backup run — the "Recent Backups" table. */
@Table({ tableName: 'backup_records' })
export class BackupRecord extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Default('FULL')
  @Column
  declare type: string;

  @Default(BackupStatus.IN_PROGRESS)
  @Column({ type: DataType.ENUM(...Object.values(BackupStatus)) })
  declare status: BackupStatus;

  @Column(DataType.BIGINT)
  declare sizeBytes: number;

  /** FileMetadata.id in auth-service, where the compressed dump is stored. */
  @Column
  declare fileId: string;

  @Column
  declare databaseCount: number;

  @Column(DataType.TEXT)
  declare errorMessage: string;

  @Column
  declare triggeredBy: string;

  @Column(DataType.DATE)
  declare startedAt: Date;

  @Column(DataType.DATE)
  declare completedAt: Date;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
