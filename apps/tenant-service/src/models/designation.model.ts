import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { Department } from './department.model';

/**
 * Lives in each tenant's own physical database (see
 * apps/tenant-service/src/services/tenant-model-provider.service.ts) — NOT
 * a shared platform table. `tenantId` is kept as a plain, non-FK column:
 * a defense-in-depth check, not the isolation boundary itself (that's the
 * separate per-tenant database). No `@BelongsTo(() => Tenant)` — Tenant
 * lives in a different physical database (the platform DB).
 */
@Table({
  tableName: 'designations',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['title'], name: 'unique_designation_title' },
    /**
     * A designation code is unique WITHIN a department, not across the
     * organization: "L2" is a legitimate level in Engineering and in Design
     * at the same time.
     *
     * This previously declared `unique: true` on `code` alone, which no
     * populated database could satisfy — every tenant with the same level in
     * two departments failed `sync()` with "code must be unique", and because
     * sync runs first that blocked column and enum reconciliation for the
     * whole tenant. The deployed databases already carry this composite
     * index; the model had drifted from them.
     */
    {
      unique: true,
      fields: ['tenantId', 'departmentId', 'code'],
      name: 'unique_designation_code_per_department',
    },
  ],
})
export class Designation extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column({ allowNull: true })
  declare code: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string;

  @ForeignKey(() => Department)
  @Column({ type: DataType.UUID, allowNull: true })
  declare departmentId: string;

  @BelongsTo(() => Department)
  declare department: Department;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;
}
