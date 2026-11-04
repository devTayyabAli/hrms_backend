import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import type { ApprovalFlow } from '../services/approval-flow';

/**
 * One row per tenant database. No row means `SINGLE` — the way every
 * organization worked before this setting existed, so an upgrade changes
 * nothing until someone opts in. New organizations are seeded with
 * `MANAGER_THEN_HR` when they are provisioned.
 */
@Table({ tableName: 'approval_settings', timestamps: true })
export class ApprovalSetting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare tenantId: string;

  @Default('SINGLE')
  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'SINGLE' })
  declare flow: ApprovalFlow;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
