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
import { User } from './user.model';
import { UserRole } from './user-role.model';
import { Permission } from './permission.model';
import { RolePermission } from './role-permission.model';

@Table({ tableName: 'roles', timestamps: true })
export class Role extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare name: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare description: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, defaultValue: false })
  declare isSystemRole: boolean;

  /**
   * False until the role's permissions have been set once — by the system
   * role seed or by an admin saving the matrix. Lets the seed give a system
   * role its defaults exactly once without ever overwriting a deliberate
   * "no permissions" choice later.
   */
  @Default(false)
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare permissionsConfigured: boolean;

  /**
   * Whose records this role's permissions reach — `ORGANIZATION`,
   * `DEPARTMENT`, `TEAM` or `SELF` (see `DataScope`). Null means
   * organization-wide, as every role worked before scopes existed.
   */
  @Column({ type: DataType.STRING(16), allowNull: true })
  declare dataScope: string | null;

  @BelongsToMany(() => User, () => UserRole)
  declare users: User[];

  @BelongsToMany(() => Permission, () => RolePermission)
  declare permissions: Permission[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
