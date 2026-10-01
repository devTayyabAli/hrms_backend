import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  Default,
  CreatedAt,
} from 'sequelize-typescript';

/**
 * Maps an employee invitation token to the tenant it belongs to, in the
 * shared platform database.
 *
 * The invitation itself (`EmployeeInvitation`) lives inside that tenant's own
 * isolated database, so resolving a bare token from an unauthenticated
 * activation link needs somewhere tenant-agnostic to start — exactly the
 * problem `OrganizationAdminInvitation` already solves for the admin flow.
 * This is that same pattern for employees: the invitation link only ever
 * carries the token, never the tenant id, so nothing exposed to the browser
 * reveals which organization a link belongs to. Only the SHA-256 hash of the
 * token is stored, matching `EmployeeInvitation`.
 */
@Table({
  tableName: 'employee_invitation_lookups',
  timestamps: true,
  updatedAt: false,
})
export class EmployeeInvitationLookup extends Model {
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.STRING(64), allowNull: false, unique: true })
  declare tokenHash: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare expiresAt: Date;

  @CreatedAt
  declare createdAt: Date;
}
