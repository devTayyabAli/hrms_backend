import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default } from 'sequelize-typescript';

/**
 * A kind of asset the organization tracks: Laptop, Monitor, Furniture…
 * Managed by the organization, so the Categories panel and the Category
 * column follow whatever they define. The first time an organization opens
 * Assets it is given a starter set.
 *
 * Lives in each tenant's own physical database; `tenantId` is a plain,
 * non-FK defense-in-depth column.
 */
@Table({
  tableName: 'asset_categories',
  timestamps: true,
  indexes: [{ unique: true, fields: ['name'], name: 'unique_asset_category_name' }],
})
export class AssetCategory extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(100), allowNull: false })
  declare name: string;

  /** A key the screen maps to an icon: laptop, monitor, smartphone… Free text; unknown keys get a default icon. */
  @Column({ type: DataType.STRING(40), allowNull: true })
  declare icon: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;
}
