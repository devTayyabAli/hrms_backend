import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { CompanyDocument } from './company-document.model';
import { Employee } from './employee.model';

/**
 * That a reminder (DUE_SOON or OVERDUE) about a document was sent to someone
 * for one version of it, so the hourly job sends each only once.
 */
@Table({
  tableName: 'company_document_ack_notices',
  timestamps: false,
  indexes: [{ unique: true, fields: ['documentId', 'employeeId', 'version', 'kind'], name: 'unique_company_document_ack_notice' }],
})
export class CompanyDocumentAckNotice extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => CompanyDocument)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare documentId: string;

  @BelongsTo(() => CompanyDocument, { foreignKey: 'documentId', onDelete: 'CASCADE' })
  declare document: CompanyDocument;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare employeeId: string;

  @BelongsTo(() => Employee, { foreignKey: 'employeeId', onDelete: 'CASCADE' })
  declare employee: Employee;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.STRING(12), allowNull: false })
  declare kind: string;
}
