import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, HasMany } from 'sequelize-typescript';
import { TrainingMaterial } from './training-material.model';

/**
 * A training course: what it is, whether it is mandatory by default, and the
 * materials in it. Lives in each tenant's own physical database; `tenantId`
 * is a plain, non-FK defense-in-depth column.
 *
 * `status` is a plain string validated by the service (DRAFT, PUBLISHED,
 * ARCHIVED). A course people have taken is archived, never deleted, so what
 * they completed stays on record.
 *
 * `requireAllMaterials`, `defaultDueDays` and `autoAssignOnJoin` are saved
 * with the course and used when courses are assigned.
 */
@Table({
  tableName: 'training_courses',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['title'], name: 'unique_training_course_title' },
    { fields: ['status'], name: 'training_course_status_idx' },
    { fields: ['category'], name: 'training_course_category_idx' },
  ],
})
export class TrainingCourse extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare category: string | null;

  @Column({ type: DataType.JSONB, allowNull: true })
  declare tags: string[] | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare mandatoryByDefault: boolean;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare estimatedMinutes: number | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare requireAllMaterials: boolean;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare defaultDueDays: number | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare autoAssignOnJoin: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'DRAFT' })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare publishedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare archivedAt: Date | null;

  @Column({ type: DataType.STRING(64), allowNull: true })
  declare createdByUserId: string | null;

  @HasMany(() => TrainingMaterial, { foreignKey: 'courseId' })
  declare materials: TrainingMaterial[];
}
