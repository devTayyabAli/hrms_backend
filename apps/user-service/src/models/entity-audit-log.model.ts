import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  CreatedAt,
} from 'sequelize-typescript';

/**
 * Generic change-history trail for this tenant's database — who created,
 * updated, or deleted which row, and (for updates) which fields changed.
 * Lives inside the tenant's own database (co-located with the data it
 * describes), same as every other tenant-scoped model.
 */
@Table({ tableName: 'entity_audit_logs', timestamps: false })
export class EntityAuditLog extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare tableName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare recordId: string;

  @Column({ type: DataType.ENUM('CREATE', 'UPDATE', 'DELETE'), allowNull: false })
  declare action: 'CREATE' | 'UPDATE' | 'DELETE';

  @Column({ type: DataType.UUID, allowNull: true })
  declare userId: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare changes: Record<string, { from: unknown; to: unknown }> | null;

  @CreatedAt
  declare createdAt: Date;
}
