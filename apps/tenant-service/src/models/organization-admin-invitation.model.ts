import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { Tenant } from './tenant.model';

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

@Table({ tableName: 'organization_admin_invitations', timestamps: true })
export class OrganizationAdminInvitation extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @Column({ type: DataType.STRING, allowNull: true })
  declare adminName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare adminEmail: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare phone: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare customMessage: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare tokenHash: string;

  @Default(InvitationStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(InvitationStatus)),
    defaultValue: InvitationStatus.PENDING,
  })
  declare status: InvitationStatus;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare acceptedAt: Date;

  @Column({ type: DataType.DATE, allowNull: true })
  declare cancelledAt: Date;

  @Column({ type: DataType.STRING, allowNull: true })
  declare createdBy: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  /**
   * Never expose tokenHash in JSON responses or APIs
   */
  toJSON(): object {
    const values = { ...this.get() };
    delete values.tokenHash;
    return values;
  }
}
