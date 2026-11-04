import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * An office or location. Lives in each tenant's own database. The head is
 * kept as a plain id, not a foreign key: employees already reference the
 * branch they work in, and a second constraint the other way would make the
 * two tables each need the other to be created first. The service checks it.
 */
@Table({
  tableName: 'branches',
  timestamps: true,
  indexes: [
    { fields: ['tenantId'], name: 'branch_tenant_idx' },
    { fields: ['headEmployeeId'], name: 'branch_head_idx' },
  ],
})
export class Branch extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(20), allowNull: true })
  declare code: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare address: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare city: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare country: string | null;

  @Column({ type: DataType.STRING(32), allowNull: true })
  declare phone: string | null;

  /** The employee who heads it. A role limited to its branch sees the branches its person heads. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare headEmployeeId: string | null;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;
}
