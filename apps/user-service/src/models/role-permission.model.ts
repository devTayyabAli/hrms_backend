import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  ForeignKey,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { Role } from './role.model';
import { Permission } from './permission.model';

/**
 * Join table between roles and permissions.
 *
 * Unique on (roleId, permissionId) for the same reason as user_roles: it
 * makes granting an already-granted permission a no-op rather than a
 * duplicate row, and it indexes the pair. The standalone permissionId index
 * covers "which roles grant this permission?".
 */
@Table({
  tableName: 'role_permissions',
  timestamps: true,
  indexes: [
    {
      name: 'unique_role_permission',
      unique: true,
      fields: ['roleId', 'permissionId'],
    },
    { name: 'idx_role_permissions_permission_id', fields: ['permissionId'] },
  ],
})
export class RolePermission extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Role)
  @Column({ type: DataType.UUID, allowNull: false })
  declare roleId: string;

  @ForeignKey(() => Permission)
  @Column({ type: DataType.UUID, allowNull: false })
  declare permissionId: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
