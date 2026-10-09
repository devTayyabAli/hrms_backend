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

  /** Why it failed (or any short qualifier), e.g. 'invalid_credentials' or an error message. */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column
  declare userAgent: string;

  @Index
  @Column
  declare module: string; // e.g. 'Authentication', 'Organizations', 'Subscriptions', 'Security', 'Reports'

  @Default('Success')
  @Index
  @Column
  declare status: string; // 'Success' | 'Failed'

  @Index
  @Column
  declare organizationName: string;

  @Column
  declare organizationLogo: string;

  @Index
  @Column
  declare userName: string;

  @Column
  declare userRole: string; // e.g. 'Organization Admin', 'Super Admin'

  @Column
  declare userAvatar: string;

  @Column
  declare actionDetails: string; // the subject, e.g. the organization or plan acted on

  @Column
  declare device: string; // e.g. 'Windows / Chrome'

  @Column({ type: DataType.JSONB, allowNull: true })
  declare changes:
    Array<{ field: string; before: any; after: any }> | Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare metadata: Record<string, any>;

  @Index
  @CreatedAt
  declare createdAt: Date;
}
