import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  CreatedAt,
  Index,
} from 'sequelize-typescript';

@Table({ tableName: 'audit_logs', updatedAt: false })
export class AuditLog extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Index
  @Column({ allowNull: false })
  declare action: string;

  @Default('unknown')
  @Column({ allowNull: false })
  declare actorType: string; // 'superadmin' | 'tenant' | 'unknown'

  @Index
  @Column
  declare userId: string; // resolved actor id, null when the lookup itself failed

  @Index
  @Column
  declare email: string; // attempted/target email, captured even on failure

  @Column
  declare tenantId: string;

  @Column
  declare ipAddress: string;

  @Column
  declare userAgent: string;

  @Index
  @Column
  declare module: string; // e.g. 'Subscriptions', 'Users', 'Roles & Permissions', 'Authentication', 'Reports'

  @Default('Active')
  @Index
  @Column
  declare status: string; // 'Active', 'Success', 'Failed', 'Warning'

  @Index
  @Column
  declare organizationName: string; // e.g. 'Oppo', 'Haier', 'Coca-Cola'

  @Column
  declare organizationLogo: string;

  @Index
  @Column
  declare userName: string; // e.g. 'David Lee', 'John Smith'

  @Column
  declare userRole: string; // e.g. 'Organization Admin', 'Super Admin'

  @Column
  declare userAvatar: string;

  @Column
  declare actionDetails: string; // e.g. 'Enterprise -> Professional', 'HR Manager'

  @Column
  declare device: string; // e.g. 'Chrome 124 on macOS'

  @Column({ type: DataType.JSONB, allowNull: true })
  declare changes: Array<{ field: string; before: any; after: any }> | Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, any>;

  @Index
  @CreatedAt
  declare createdAt: Date;
}
