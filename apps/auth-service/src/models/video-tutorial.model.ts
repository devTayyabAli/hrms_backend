import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, Index, CreatedAt, UpdatedAt } from 'sequelize-typescript';
import { HelpCategory } from '@app/common';

@Table({ tableName: 'video_tutorials' })
export class VideoTutorial extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false })
  declare title: string;

  @Index
  @Column({ type: DataType.ENUM(...Object.values(HelpCategory)), allowNull: false })
  declare category: HelpCategory;

  @Column(DataType.STRING(500))
  declare description: string;

  @Column({ allowNull: false })
  declare videoUrl: string;

  @Column
  declare thumbnailUrl: string;

  /** Stored in seconds; the API also returns it formatted as mm:ss. */
  @Column(DataType.INTEGER)
  declare durationSeconds: number;

  @Default(0)
  @Column(DataType.INTEGER)
  declare views: number;

  @Default(true)
  @Column
  declare isPublished: boolean;

  @Column(DataType.DATE)
  declare publishedAt: Date;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
