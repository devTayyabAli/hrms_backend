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

/**
 * Lives in each tenant's own physical database — NOT a shared platform
 * table. `tenantId` is a plain, non-FK defense-in-depth column; the actual
 * isolation boundary is the per-tenant database itself.
 */
@Table({
  tableName: 'organization_module_access',
  timestamps: true,
  indexes: [
    // Unique on moduleKey alone, not [tenantId, moduleKey]: every row in
    // this table lives in one tenant's own physical database, so tenantId
    // is constant here and a compound index would be redundant dead weight.
    {
      unique: true,
      fields: ['moduleKey'],
      name: 'unique_module_key',
    },
  ],
})
export class OrganizationModuleAccess extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare moduleKey: string;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare enabled: boolean;

  @Column({ type: DataType.JSON, allowNull: true })
  declare allowedActions: string[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
