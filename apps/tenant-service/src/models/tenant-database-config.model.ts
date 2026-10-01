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
import { CryptoUtils } from '@app/common';

export enum TenantDbStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  FAILED = 'FAILED',
}

@Table({ tableName: 'tenant_database_configs', timestamps: true })
export class TenantDatabaseConfig extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare tenantId: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @Column({ type: DataType.STRING, allowNull: false })
  declare databaseName: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare host: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare port: number;

  @Column({ type: DataType.STRING, allowNull: false })
  declare username: string;

  @Column({
    type: DataType.STRING,
    allowNull: false,
    set(value: string) {
      this.setDataValue('password', CryptoUtils.encrypt(value));
    },
    get(): string {
      const raw = this.getDataValue('password');
      return CryptoUtils.decrypt(raw);
    },
  })
  declare password: string;

  @Column({
    type: DataType.ENUM('postgres', 'mysql'),
    defaultValue: 'postgres',
  })
  declare dialect: 'postgres' | 'mysql';

  @Column({ type: DataType.BOOLEAN, defaultValue: true })
  declare isActive: boolean;

  @Default(TenantDbStatus.ACTIVE)
  @Column({
    type: DataType.ENUM(...Object.values(TenantDbStatus)),
    defaultValue: TenantDbStatus.ACTIVE,
  })
  declare status: TenantDbStatus;

  @Column({ type: DataType.JSON, allowNull: true })
  declare poolConfig: {
    max: number;
    min: number;
    idle: number;
  };

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  /**
   * Return clean public representation stripping sensitive DB credentials
   */
  toJSON(): object {
    const values = { ...this.get() };
    delete values.password;
    return values;
  }
}
