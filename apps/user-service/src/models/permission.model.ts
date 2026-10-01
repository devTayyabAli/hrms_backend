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
  BelongsToMany,
} from 'sequelize-typescript';
import { Role } from './role.model';
import { RolePermission } from './role-permission.model';

/**
 * The permission catalogue, seeded per tenant by PermissionRegistryService.
 *
 * (resource, action) is unique because it is the permission's real identity —
 * the id is only a surrogate. Without the constraint, a re-run of the seed
 * inserts a second 'employee'/'view' row, and role grants then point at
 * whichever duplicate was found first, so the same permission can read as
 * granted on one screen and not on another. The index also serves the lookup
 * the seeder performs on every run.
 */
@Table({
  tableName: 'permissions',
  timestamps: true,
  indexes: [
    {
      name: 'unique_permission_resource_action',
      unique: true,
      fields: ['resource', 'action'],
    },
  ],
})
export class Permission extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare resource: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare action: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare description: string;

  @BelongsToMany(() => Role, () => RolePermission)
  declare roles: Role[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
