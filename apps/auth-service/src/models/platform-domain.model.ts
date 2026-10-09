import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, CreatedAt } from 'sequelize-typescript';

export enum DomainStatus {
  PRIMARY = 'PRIMARY',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/**
 * Custom platform domains and the result of checking each one (DNS and certificate).
 * The hosting provider issues the certificate and routes the domain;
 * CustomDomainsService verifies both and records the result here.
 * `sslEnabled` mirrors whether a valid certificate was found.
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

  /** pending (no record yet) | verified | misconfigured (points elsewhere). */
  @Default('pending')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare dnsStatus: string;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare dnsDetail: string | null;

  /** pending (no HTTPS yet) | valid | expiring | invalid. */
  @Default('pending')
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare sslStatus: string;

  @Column({ type: DataType.STRING(300), allowNull: true })
  declare sslDetail: string | null;

  @Column({ type: DataType.STRING(120), allowNull: true })
  declare sslIssuer: string | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare sslExpiresAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare lastCheckedAt: Date | null;

  @CreatedAt
  declare createdAt: Date;
}
