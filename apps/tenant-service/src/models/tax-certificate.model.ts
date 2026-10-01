import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';

/**
 * An issued annual tax certificate. It keeps the figures it was issued
 * with — summed from locked payroll snapshots at the time — so a reprint is
 * always identical to what the employee was given. If later months change
 * the year's totals, issuing again creates a new certificate; the old one
 * stays on record.
 */
@Table({
  tableName: 'tax_certificates',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['certificateNumber'],
      name: 'tax_certificate_number_unique',
    },
    {
      unique: true,
      fields: ['sequence'],
      name: 'tax_certificate_sequence_unique',
    },
    {
      fields: ['employeeId', 'taxYear'],
      name: 'tax_certificate_employee_year_idx',
    },
  ],
})
export class TaxCertificate extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare taxYear: number;

  @Column({ type: DataType.STRING(32), allowNull: false })
  declare certificateNumber: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sequence: number;

  /** The annual summary as issued — the certificate is printed from this. */
  @Column({ type: DataType.JSONB, allowNull: false })
  declare summary: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: false })
  declare generatedAt: Date;

  @Column({ type: DataType.STRING, allowNull: true })
  declare generatedByEmail: string | null;
}
