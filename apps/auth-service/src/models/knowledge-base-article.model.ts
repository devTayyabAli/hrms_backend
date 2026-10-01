import { Table, Column, Model, DataType, PrimaryKey, IsUUID, Default, Index, CreatedAt, UpdatedAt } from 'sequelize-typescript';
import { HelpCategory } from '@app/common';

@Table({ tableName: 'knowledge_base_articles' })
export class KnowledgeBaseArticle extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false })
  declare title: string;

  @Index
  @Column({ allowNull: false, unique: true })
  declare slug: string;

  @Index
  @Column({ type: DataType.ENUM(...Object.values(HelpCategory)), allowNull: false })
  declare category: HelpCategory;

  @Column(DataType.STRING(500))
  declare excerpt: string;

  @Column(DataType.TEXT)
  declare content: string;

  /** Drives the "Trending" tab and the "2.1K views" label. */
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
