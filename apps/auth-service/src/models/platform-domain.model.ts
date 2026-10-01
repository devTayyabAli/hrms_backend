import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt } from 'sequelize-typescript';

export enum DomainStatus {
  PRIMARY = 'PRIMARY',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/**
 * Configured platform domain registry (e.g. hr.fuutura.com, careers.fuutura.com).
 * `sslEnabled`/`redirectHttpToHttps` are stored preferences only — no ACME/DNS
 * client or reverse-proxy integration exists in this codebase, so no
 * certificate is ever actually issued or verified from these values.
 */
// `updatedAt: false` (rather than timestamps: false) — Sequelize must still
// manage `createdAt`, which is the "Added On" column in the Domains table.
@Table({ tableName: 'platform_domains', updatedAt: false })
export class PlatformDomain extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false, unique: true })
  declare domain: string;

  @Default(DomainStatus.ACTIVE)
  @Column({ type: DataType.ENUM(...Object.values(DomainStatus)) })
  declare status: DomainStatus;

  @Default(false)
  @Column
  declare sslEnabled: boolean;

  @Default(false)
  @Column
  declare redirectHttpToHttps: boolean;

  @CreatedAt
  declare createdAt: Date;
}
