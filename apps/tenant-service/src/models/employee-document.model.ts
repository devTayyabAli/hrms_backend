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
import { EmployeeDocumentCategory, EmployeeDocumentStatus } from '@app/common';
import { Employee } from './employee.model';

export { EmployeeDocumentCategory, EmployeeDocumentStatus };

/**
 * A file the employee uploaded on My Documents. The bytes live in the shared
 * file store (`fileId`); this row is the category, size and verification
 * badge the table renders.
 */
@Table({
  tableName: 'employee_documents',
  timestamps: true,
  indexes: [
    { fields: ['employeeId', 'category'], name: 'employee_document_employee_category_idx' },
    { fields: ['status'], name: 'employee_document_status_idx' },
  ],
})
export class EmployeeDocument extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false })
  declare employeeId: string;

  @BelongsTo(() => Employee, 'employeeId')
  declare employee: Employee;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare title: string;

  @Column({
    type: DataType.ENUM(...Object.values(EmployeeDocumentCategory)),
    allowNull: false,
  })
  declare category: EmployeeDocumentCategory;

  @Column({ type: DataType.UUID, allowNull: false })
  declare fileId: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare fileName: string;

  @Column({ type: DataType.STRING(127), allowNull: true })
  declare mimeType: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sizeBytes: number;

  @Default(EmployeeDocumentStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(EmployeeDocumentStatus)),
    allowNull: false,
    defaultValue: EmployeeDocumentStatus.PENDING,
  })
  declare status: EmployeeDocumentStatus;

  /** HR's note to the employee — why it was rejected, or anything to know. */
  @Column({ type: DataType.STRING(500), allowNull: true })
  declare reviewNote: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare reviewedAt: Date | null;

  /** A user-service User id, so intentionally not an FK (different database). */
  @Column({ type: DataType.UUID, allowNull: true })
  declare reviewedByUserId: string | null;

  /** When the document stops being valid — a passport, visa or certificate. */
  @Column({ type: DataType.DATEONLY, allowNull: true })
  declare expiryDate: string | null;
}
