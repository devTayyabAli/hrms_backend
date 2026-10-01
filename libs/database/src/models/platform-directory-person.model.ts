import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
} from 'sequelize-typescript';

/** Which tenant-side table a projection row was built from. */
export enum DirectorySourceType {
  USER = 'USER',
  EMPLOYEE = 'EMPLOYEE',
}

/**
 * Precomputed so the listing never has to categorize a role name at read
 * time. Mirrors PlatformClientsService.categorizeRole exactly — these values
 * are already the API's contract, so a new member here would change what the
 * Clients screen renders.
 */
export enum DirectoryRoleCategory {
  ADMIN = 'ADMIN',
  HR = 'HR',
  EMPLOYEE = 'EMPLOYEE',
  OTHER = 'OTHER',
}

/**
 * The single definition of how a role name becomes a category.
 *
 * Shared rather than duplicated: the projection writer and any remaining
 * direct reader must agree, or the same person is filed under one category
 * when written and searched for under another.
 */
export function categorizeRoleName(roleName?: string | null): DirectoryRoleCategory {
  const name = (roleName || '').toUpperCase();
  if (name.includes('ADMIN')) return DirectoryRoleCategory.ADMIN;
  if (name.includes('HR')) return DirectoryRoleCategory.HR;
  if (name.includes('EMPLOYEE')) return DirectoryRoleCategory.EMPLOYEE;
  return DirectoryRoleCategory.OTHER;
}

/**
 * Read model for the SuperAdmin Clients directory.
 *
 * Lives in the PLATFORM database and holds one flat, denormalised row per
 * person across every tenant — only the fields that screen lists. Tenant
 * databases remain the system of record; this table is derived, disposable
 * and rebuildable from them at any time (see rebuild-directory.ts).
 *
 * `tenantId` and `sourceId` are plain columns with no foreign key: the rows
 * they point at live in a different physical database, so referential
 * integrity is maintained by the projection events and the reconciliation
 * sweep rather than by Postgres.
 *
 * Never read anything authoritative from here — permissions, seat limits and
 * billing must go to the tenant database. This table is allowed to be a few
 * seconds stale.
 */
@Table({
  tableName: 'platform_directory_person',
  timestamps: true,
  indexes: [
    {
      name: 'directory_source_unique_idx',
      unique: true,
      fields: ['tenantId', 'sourceType', 'sourceId'],
    },
    // The default Clients listing: contacts, newest first.
    { name: 'directory_listing_idx', fields: ['roleCategory', 'isActive', 'sourceCreatedAt'] },
    { name: 'directory_tenant_idx', fields: ['tenantId', 'roleCategory'] },
    { name: 'directory_email_idx', fields: ['email'] },
  ],
})
export class PlatformDirectoryPerson extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Default(DirectorySourceType.USER)
  @Column({
    type: DataType.ENUM(...Object.values(DirectorySourceType)),
    allowNull: false,
    defaultValue: DirectorySourceType.USER,
  })
  declare sourceType: DirectorySourceType;

  /** The id of the row in the tenant database this was projected from. */
  @Column({ type: DataType.UUID, allowNull: false })
  declare sourceId: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare organizationName: string | null;

  @Column({ type: DataType.STRING(255), allowNull: false, defaultValue: '' })
  declare name: string;

  @Column({ type: DataType.STRING(255), allowNull: false, defaultValue: '' })
  declare email: string;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare phone: string | null;

  /** The department NAME, not its id — the listing shows text. */
  @Column({ type: DataType.STRING(255), allowNull: true })
  declare department: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare role: string | null;

  @Default(DirectoryRoleCategory.EMPLOYEE)
  @Column({
    type: DataType.ENUM(...Object.values(DirectoryRoleCategory)),
    allowNull: false,
    defaultValue: DirectoryRoleCategory.EMPLOYEE,
  })
  declare roleCategory: DirectoryRoleCategory;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare employeeCode: string | null;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare isActive: boolean;

  /** The SOURCE row's timestamps, so the listing sorts by when the person was added. */
  @Column({ type: DataType.DATE, allowNull: true })
  declare sourceCreatedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare sourceUpdatedAt: Date | null;

  /**
   * Monotonic per source row. An apply is discarded when it carries a version
   * lower than the one stored, which is what makes at-least-once delivery and
   * out-of-order arrival safe.
   */
  @Default(0)
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare version: string;

  /**
   * Tombstone. A delete sets this rather than removing the row immediately,
   * so a late UPDATE for the same person cannot resurrect it. Purged by the
   * reconciliation sweep once the retention window has passed.
   */
  @Column({ type: DataType.DATE, allowNull: true })
  declare deletedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare syncedAt: Date | null;
}
