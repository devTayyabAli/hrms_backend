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
import { PolicyType, PolicyStatus, PolicySource } from '@app/common';

/**
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself. No
 * `@BelongsTo(() => Tenant)` — Tenant lives in the platform database, a
 * different physical connection.
 */
@Table({
  tableName: 'organization_policies',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['policyType', 'version'],
      name: 'unique_org_policy_type_version',
    },
    { fields: ['tenantId', 'policyType'], name: 'idx_org_policy_tenant_type' },
    {
      fields: ['tenantId', 'policyType', 'status'],
      name: 'idx_org_policy_tenant_type_status',
    },
    { fields: ['effectiveFrom'], name: 'idx_org_policy_effective_from' },
  ],
})
export class OrganizationPolicy extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  // ==========================================
  // TENANT SCOPING
  // ==========================================

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  // ==========================================
  // POLICY IDENTITY
  // ==========================================

  @Column({
    type: DataType.ENUM(...Object.values(PolicyType)),
    allowNull: false,
  })
  declare policyType: PolicyType;

  @Default(PolicySource.SYSTEM)
  @Column({
    type: DataType.ENUM(...Object.values(PolicySource)),
    allowNull: false,
    defaultValue: PolicySource.SYSTEM,
  })
  declare source: PolicySource;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  // ==========================================
  // JSONB CONFIGURATION
  // ==========================================

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
  })
  declare configuration: Record<string, unknown>;

  // ==========================================
  // VERSIONING
  // ==========================================

  @Default(1)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /**
   * Points to the previous version of this policy (self-referencing FK).
   * NULL means this is the first version.
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare previousVersionId: string | null;

  // ==========================================
  // LIFECYCLE STATUS
  // ==========================================

  @Default(PolicyStatus.DRAFT)
  @Column({
    type: DataType.ENUM(...Object.values(PolicyStatus)),
    allowNull: false,
    defaultValue: PolicyStatus.DRAFT,
  })
  declare status: PolicyStatus;

  // ==========================================
  // EFFECTIVE DATES
  // ==========================================

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveFrom: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare effectiveTo: string | null;

  // ==========================================
  // AUDIT FIELDS
  // ==========================================

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdBy: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare updatedBy: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare activatedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare activatedAt: Date | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
