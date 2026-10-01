import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';
import { DirectorySourceType } from './platform-directory-person.model';

export enum ProjectionEventType {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  DELETED = 'DELETED',
}

/** The flattened person as it will be written to the directory. */
export interface DirectoryPayload {
  name?: string;
  email?: string;
  phone?: string | null;
  department?: string | null;
  role?: string | null;
  roleCategory?: string;
  employeeCode?: string | null;
  isActive?: boolean;
  sourceCreatedAt?: string | Date | null;
  sourceUpdatedAt?: string | Date | null;
}

/**
 * Transactional outbox. Lives in each TENANT database, beside the rows it
 * describes.
 *
 * It is written in the same transaction as the domain change, which is the
 * entire point: a crash between "employee saved" and "event queued" cannot
 * leave the two disagreeing, because there is only one commit. A dual-write
 * without this guarantee loses events precisely when the system is already
 * unhealthy.
 *
 * Rows are drained by ProjectionRelayService in tenant-service and kept for a
 * short while after processing so a replay can be investigated.
 */
@Table({
  tableName: 'projection_outbox',
  timestamps: true,
  updatedAt: false,
  indexes: [
    // The relay's only query: unprocessed work, oldest first.
    { name: 'outbox_pending_idx', fields: ['processedAt', 'occurredAt'] },
    { name: 'outbox_aggregate_idx', fields: ['aggregateType', 'aggregateId'] },
  ],
})
export class ProjectionOutbox extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({
    type: DataType.ENUM(...Object.values(DirectorySourceType)),
    allowNull: false,
  })
  declare aggregateType: DirectorySourceType;

  @Column({ type: DataType.UUID, allowNull: false })
  declare aggregateId: string;

  @Column({
    type: DataType.ENUM(...Object.values(ProjectionEventType)),
    allowNull: false,
  })
  declare eventType: ProjectionEventType;

  /** Null for DELETED — there is nothing left to describe. */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare payload: DirectoryPayload | null;

  /** Monotonic; the directory discards an apply older than what it holds. */
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare version: string;

  @Default(DataType.NOW)
  @Column({ type: DataType.DATE, allowNull: false, defaultValue: DataType.NOW })
  declare occurredAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare processedAt: Date | null;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare lastError: string | null;
}
