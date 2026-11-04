import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  IsUUID,
  Default,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { TrainingCourse } from './training-course.model';

/**
 * One thing to read or watch in a course: an uploaded file (PDF, document), a
 * video link, or any other external resource. Deleted with its course.
 *
 * A file is a reference into the shared file store; removing the material does
 * not delete the stored file, since a duplicated course may still use it.
 * `kind` is a plain string validated by the service (FILE, VIDEO_LINK, LINK).
 */
@Table({
  tableName: 'training_materials',
  timestamps: true,
  indexes: [{ fields: ['courseId', 'sortOrder'], name: 'training_material_course_idx' }],
})
export class TrainingMaterial extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => TrainingCourse)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare courseId: string;

  @BelongsTo(() => TrainingCourse, { foreignKey: 'courseId', onDelete: 'CASCADE' })
  declare course: TrainingCourse;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare kind: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare title: string;

  /** For a link. */
  @Column({ type: DataType.STRING(2000), allowNull: true })
  declare url: string | null;

  /** For a file: its id in the file store, and its facts at the time it was attached. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare fileId: string | null;

  @Column({ type: DataType.STRING(255), allowNull: true })
  declare fileName: string | null;

  @Column({ type: DataType.STRING(150), allowNull: true })
  declare mimeType: string | null;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare sizeBytes: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare sortOrder: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare required: boolean;
}
