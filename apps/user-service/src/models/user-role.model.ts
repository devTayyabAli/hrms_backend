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
import { User } from './user.model';
import { Role } from './role.model';

/**
 * Join table between users and roles.
 *
 * The unique index is what makes role assignment idempotent: without it,
 * assigning a role a user already has inserts a second row, and every query
 * that eager-loads roles then returns that role twice. It doubles as the
 * lookup index for the (userId, roleId) pair, which every permission check
 * walks.
 *
 * The standalone roleId index covers the other direction — "who has this
 * role?", asked on every role-deletion check — which the composite index
 * cannot answer without a full scan, since roleId is not its leading column.
 */
@Table({
  tableName: 'user_roles',
  timestamps: true,
  indexes: [
    { name: 'unique_user_role', unique: true, fields: ['userId', 'roleId'] },
    { name: 'idx_user_roles_role_id', fields: ['roleId'] },
  ],
})
export class UserRole extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: false })
  declare userId: string;

  @ForeignKey(() => Role)
  @Column({ type: DataType.UUID, allowNull: false })
  declare roleId: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
