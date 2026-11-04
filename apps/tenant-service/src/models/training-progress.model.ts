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
import { TrainingAssignment } from './training-assignment.model';
import { TrainingMaterial } from './training-material.model';

/**
 * That a person opened a material, and when they first did. Progress is how
 * many of a course's materials have a row here. Removed with the assignment or
 * the material it is about.
 */
@Table({
  tableName: 'training_progress',
  timestamps: false,
  indexes: [{ unique: true, fields: ['assignmentId', 'materialId'], name: 'unique_training_progress' }],
})
export class TrainingProgress extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column(DataType.UUID)
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => TrainingAssignment)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare assignmentId: string;

  @BelongsTo(() => TrainingAssignment, { foreignKey: 'assignmentId', onDelete: 'CASCADE' })
  declare assignment: TrainingAssignment;

  @ForeignKey(() => TrainingMaterial)
  @Column({ type: DataType.UUID, allowNull: false, onDelete: 'CASCADE' })
  declare materialId: string;

  @BelongsTo(() => TrainingMaterial, { foreignKey: 'materialId', onDelete: 'CASCADE' })
  declare material: TrainingMaterial;

  @Column({ type: DataType.DATE, allowNull: false })
  declare openedAt: Date;
}
