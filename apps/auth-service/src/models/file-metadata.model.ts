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
  DeletedAt,
  Index,
} from 'sequelize-typescript';

@Table({ tableName: 'file_metadata', paranoid: true })
export class FileMetadata extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Index
  @Column
  declare tenantId: string; // 'platform' or tenant ID

  @Index
  @Column({ allowNull: false })
  declare uploadedBy: string;

  @Column({ allowNull: false })
  declare originalName: string;

  @Index
  @Column({ allowNull: false, unique: true })
  declare storageKey: string;

  @Default('local')
  @Column({ allowNull: false })
  declare storageProvider: string; // 's3' | 'local'

  @Column({ allowNull: false })
  declare mimeType: string;

  @Column({ allowNull: false })
  declare extension: string;

  @Column({ allowNull: false, type: DataType.BIGINT })
  declare size: number;

  @Index
  @Default('general')
  @Column
  declare category: string;

  @Index
  @Column
  declare entityType: string;

  @Index
  @Column
  declare entityId: string;

  @Default(false)
  @Column
  declare isPublic: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @DeletedAt
  declare deletedAt: Date;
}
