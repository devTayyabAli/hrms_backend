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
  HasMany,
} from 'sequelize-typescript';
import { PayrollComponent } from './payroll-component.model';

/**
 * A reusable compensation template — "Management Package": which
 * components, and how each is worked out. Assigning it to an employee copies
 * it onto their compensation; changing it later doesn't change anyone.
 */
@Table({
  tableName: 'salary_structures',
  timestamps: true,
  indexes: [{ unique: true, fields: ['code'], name: 'salary_structure_code_unique' }],
})
export class SalaryStructure extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare code: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  declare effectiveFrom: string;

  /** ACTIVE | INACTIVE — only an active structure can be assigned. */
  @Default('ACTIVE')
  @Column({ type: DataType.STRING(12), allowNull: false, defaultValue: 'ACTIVE' })
  declare status: string;

  @HasMany(() => SalaryStructureComponent, 'structureId')
  declare components: SalaryStructureComponent[];

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdByEmail: string | null;

  @Column({ type: DataType.STRING, allowNull: true })
  declare updatedByEmail: string | null;
}

/**
 * A component on a structure. The calculation fields override the
 * component's own defaults (e.g. Housing = 20% of Basic in this package);
 * null keeps the component's.
 */
@Table({
  tableName: 'salary_structure_components',
  timestamps: true,
  indexes: [{ unique: true, fields: ['structureId', 'componentId'], name: 'salary_structure_component_unique' }],
})
export class SalaryStructureComponent extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => SalaryStructure)
  @Column({ type: DataType.UUID, allowNull: false })
  declare structureId: string;

  @BelongsTo(() => SalaryStructure, { foreignKey: 'structureId', onDelete: 'CASCADE' })
  declare structure: SalaryStructure;

  @ForeignKey(() => PayrollComponent)
  @Column({ type: DataType.UUID, allowNull: false })
  declare componentId: string;

  @BelongsTo(() => PayrollComponent, 'componentId')
  declare component: PayrollComponent;

  @Column({ type: DataType.STRING(16), allowNull: true })
  declare calculationMethod: string | null;

  @Column({ type: DataType.DECIMAL(14, 4), allowNull: true })
  declare value: string | null;

  @Column({ type: DataType.STRING(24), allowNull: true })
  declare percentageBase: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare baseComponents: string[] | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare formula: string | null;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;
}
