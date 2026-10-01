import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  Unique,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * Platform-wide settings, one row per category.
 *
 * A JSONB bag rather than a column per field: these are presentation and
 * policy preferences that change shape often, and a column each would mean a
 * migration every time the settings screen grows a toggle. The service owns
 * the defaults, so a category with no row yet still reads back complete.
 *
 * Not `platform_settings`: a table by that name already exists in the
 * database, left behind by earlier work that no model in this repo maps to
 * any more. `sync()` only creates missing tables and never alters existing
 * ones, so sharing the name silently produced a model whose columns weren't
 * there. Its one row of real settings is carried into the `general` category
 * here rather than being dropped.
 */
@Table({ tableName: 'platform_setting_groups', timestamps: true })
export class PlatformSetting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Unique
  @Column({ allowNull: false })
  declare category: string; // 'general' | 'security' | 'maintenance'

  @Default({})
  @Column({ type: DataType.JSONB, allowNull: false })
  declare values: Record<string, any>;

  /** The SuperAdmin who last saved this category. */
  @Column
  declare updatedBy: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
