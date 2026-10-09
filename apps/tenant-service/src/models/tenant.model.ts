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
  HasOne,
  HasMany,
} from 'sequelize-typescript';
import { TenantDatabaseConfig } from './tenant-database-config.model';
import { OrganizationAdminInvitation } from './organization-admin-invitation.model';
import { Subscription } from './subscription.model';
import { Payment } from './payment.model';
import { Invoice } from './invoice.model';

export interface TenantSetupRequest {
  modules: { moduleKey: string; enabled: boolean; allowedActions?: string[] }[];
  sendInvitation: boolean;
  adminName: string | null;
  adminPhone: string | null;
  customMessage: string | null;
  planId: string | null;
  billingCycle: string | null;
  /** Set when every setup step has finished. */
  completedAt: string | null;
  /** The step that last failed and why, cleared on success. */
  lastError: string | null;
}

export enum TenantStatus {
  DRAFT = 'DRAFT',
  PENDING_SUBSCRIPTION = 'PENDING_SUBSCRIPTION',
  PENDING_ADMIN_ACTIVATION = 'PENDING_ADMIN_ACTIVATION',
  SETUP_IN_PROGRESS = 'SETUP_IN_PROGRESS',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  EXPIRED = 'EXPIRED',
}

export enum TenantSetupStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

export enum TenantProvisioningStatus {
  PENDING = 'PENDING',
  PROVISIONING = 'PROVISIONING',
  READY = 'READY',
  FAILED = 'FAILED',
}

@Table({ tableName: 'tenants' })
export class Tenant extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ allowNull: true })
  declare organizationName: string;

  @Column({ allowNull: true })
  declare shortName: string;

  @Column({ allowNull: true })
  declare officialEmail: string;

  @Column({ allowNull: true })
  declare companySize: string;

  @Column({ allowNull: true })
  declare logoUrl: string;

  @Column({ allowNull: true })
  declare legalName: string;

  @Column({ allowNull: true })
  declare industry: string;

  @Column({ allowNull: true })
  declare phone: string;

  @Column({ allowNull: true })
  declare website: string;

  @Column({ allowNull: true })
  declare country: string;

  @Column({ allowNull: true })
  declare state: string;

  @Column({ allowNull: true })
  declare city: string;

  @Column({ allowNull: true })
  declare address: string;

  @Column({ allowNull: true })
  declare timezone: string;

  @Column({ allowNull: true })
  declare currency: string;

  @Column({ unique: true, allowNull: true })
  declare slug: string;

  @Column({ allowNull: true })
  declare email: string;

  @Column({ allowNull: true })
  declare adminEmail: string;

  @Column({ allowNull: true })
  declare adminDesignation: string;

  /**
   * The primary admin's profile photo, captured during organization creation.
   *
   * Separate from `logoUrl`: that is the organization's own mark, which the
   * admin later sets in the setup wizard. Provisioning used to write the
   * admin's photo into `logoUrl`, so the two overwrote each other and neither
   * could be displayed reliably.
   */
  @Column({ allowNull: true })
  declare adminAvatarUrl: string;

  @Default('standard')
  @Column({ allowNull: true })
  declare planType: string;

  @Column({ unique: true, allowNull: true })
  declare domain: string;

  @Default(true)
  @Column
  declare isActive: boolean;

  @Default(TenantStatus.DRAFT)
  @Column({
    type: DataType.ENUM(...Object.values(TenantStatus)),
    defaultValue: TenantStatus.DRAFT,
  })
  declare status: TenantStatus;

  @Default(TenantSetupStatus.NOT_STARTED)
  @Column({
    type: DataType.ENUM(...Object.values(TenantSetupStatus)),
    defaultValue: TenantSetupStatus.NOT_STARTED,
  })
  declare setupStatus: TenantSetupStatus;

  @Default(TenantProvisioningStatus.PENDING)
  @Column({
    type: DataType.ENUM(...Object.values(TenantProvisioningStatus)),
    defaultValue: TenantProvisioningStatus.PENDING,
  })
  declare provisioningStatus: TenantProvisioningStatus;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare provisioningError: string;

  /**
   * What the Super Admin asked for when creating the organization — modules,
   * whether to invite the admin and who they are — so a failed setup can be
   * retried to completion, and a first invitation sent later still knows the
   * admin's name. `completedAt` is set once every step has run.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare setupRequest: TenantSetupRequest | null;

  @HasOne(() => TenantDatabaseConfig)
  declare databaseConfig: TenantDatabaseConfig;

  // No @HasMany for Department/Designation/OrganizationPolicy/WorkingHours/
  // LeavePolicy/AttendancePolicy/OrganizationModuleAccess: those models now
  // live in this tenant's own per-tenant database (a different physical
  // connection than this platform-DB Tenant row), so a Sequelize association
  // across the two isn't possible — see tenant-model-provider.service.ts.

  @HasMany(() => OrganizationAdminInvitation)
  declare adminInvitations: OrganizationAdminInvitation[];

  @HasMany(() => Subscription)
  declare subscriptions: Subscription[];

  @HasMany(() => Payment)
  declare payments: Payment[];

  @HasMany(() => Invoice)
  declare invoices: Invoice[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
