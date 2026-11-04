import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { CompanyDocument } from './company-document.model';
import { Employee } from './employee.model';

/**
 * That an employee read and accepted a company document, for one version of
 * it. When the document changes or is sent again its version goes up, and
 * everyone is asked afresh; the earlier rows stay as the record.
 */
@Table({
  tableName: 'company_document_acknowledgements',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['documentId', 'employeeId', 'version'], name: 'unique_company_document_ack' },
    { fields: ['employeeId'], name: 'company_document_ack_employee_idx' },
  ],
})
export class CompanyDocumentAcknowledgement extends Model {
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

  @Column({ type: DataType.DATE, allowNull: false })
  declare acknowledgedAt: Date;
}
