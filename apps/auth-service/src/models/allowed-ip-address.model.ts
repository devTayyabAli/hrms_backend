import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt } from 'sequelize-typescript';

// `updatedAt: false` (rather than timestamps: false) — Sequelize must still
// manage `createdAt`, which the allowlist is ordered by.
@Table({ tableName: 'allowed_ip_addresses', updatedAt: false })
export class AllowedIpAddress extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false, unique: true })
  declare ipOrCidr: string;

  @CreatedAt
  declare createdAt: Date;
}
