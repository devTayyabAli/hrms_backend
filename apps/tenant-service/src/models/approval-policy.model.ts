import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';
import type { PolicyStage } from '../services/approval-engine';

/**
 * How one kind of request is approved: an ordered list of stages. One row per
 * request type per organization. No row means the built-in route, which is
 * how every organization worked before this was configurable, so an upgrade
 * changes nothing until someone saves one.
 */
@Table({
  tableName: 'approval_policies',
  timestamps: true,
  indexes: [{ unique: true, fields: ['tenantId', 'requestType'], name: 'unique_approval_policy_type' }],
})
export class ApprovalPolicy extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  /** What is being approved, e.g. LEAVE. */
  @Column({ type: DataType.STRING(32), allowNull: false })
  declare requestType: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare stages: PolicyStage[];

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare updatedByEmail: string | null;
}
