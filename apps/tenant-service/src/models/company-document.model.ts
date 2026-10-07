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
import { CompanyDocumentCategory, CompanyDocumentStatus } from '@app/common';
import { Employee } from './employee.model';

/**
 * A file in the company library (Workspace › Documents). The bytes live in
 * the shared file store; `fileId` points at them. Only PUBLISHED documents
 * are shown to employees.
 */
@Table({
  tableName: 'company_documents',
  timestamps: true,
  indexes: [
    { fields: ['status'], name: 'company_document_status_idx' },
    { fields: ['category'], name: 'company_document_category_idx' },
  ],
})
export class CompanyDocument extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(150), allowNull: false })
  declare name: string;

  @Column({ type: DataType.ENUM(...Object.values(CompanyDocumentCategory)), allowNull: false })
  declare category: CompanyDocumentCategory;

  @Default(CompanyDocumentStatus.DRAFT)
  @Column({ type: DataType.ENUM(...Object.values(CompanyDocumentStatus)), allowNull: false })
  declare status: CompanyDocumentStatus;

  @ForeignKey(() => Employee)
  @Column({ type: DataType.UUID, allowNull: true, onDelete: 'SET NULL' })
  declare ownerEmployeeId: string | null;

  @BelongsTo(() => Employee, { foreignKey: 'ownerEmployeeId', as: 'owner' })
  declare owner: Employee | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  /** `file_metadata.id` in the shared file store. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare fileId: string;

  @Column({ type: DataType.STRING(255), allowNull: false })
  declare fileName: string;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare mimeType: string | null;

  @Default(0)
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare sizeBytes: number;

  /** When it was last made PUBLISHED. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare createdByUserId: string | null;
}
