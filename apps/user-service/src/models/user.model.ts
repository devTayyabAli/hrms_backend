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
import { UserRole } from './user-role.model';

@Table({ tableName: 'users', timestamps: true })
export class User extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING, allowNull: false, unique: true })
  declare email: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare passwordHash: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare firstName: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare lastName: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare phone: string;

  @Column({ type: DataType.STRING, allowNull: true })
  declare department: string;

  @Default(true)
  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;

  @BelongsToMany(() => Role, () => UserRole)
  declare roles: Role[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
