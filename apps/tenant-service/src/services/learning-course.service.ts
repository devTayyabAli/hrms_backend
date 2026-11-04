import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, QueryTypes, UniqueConstraintError, literal } from 'sequelize';
import {
  AddTrainingMaterialDto,
  CreateTrainingCourseDto,
  GetTrainingCoursesQueryDto,
  LearningActorDto,
  SetTrainingMaterialOrderDto,
  TRAINING_MAX_MATERIALS,
  TRAINING_MAX_TAGS,
  TRAINING_TAG_MAX,
  TenantErrorCode,
  TenantException,
  TrainingCourseStatus,
  TrainingFileDto,
  TrainingMaterialKind,
  UpdateTrainingCourseDto,
  UpdateTrainingMaterialDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields } from './workspace-shared';

const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
const TITLE_MAX = 200;
const COPY_ATTEMPTS = 50;

export interface TrainingMaterialRow {
  id: string;
  kind: TrainingMaterialKind;
  title: string;
  url: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  required: boolean;
  sortOrder: number;
  /** Relative to the API root, for a file; the same headers as any other call. Null for a link. */
  downloadPath: string | null;
}

export interface TrainingCourseRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  mandatoryByDefault: boolean;
  estimatedMinutes: number | null;
  requireAllMaterials: boolean;
  defaultDueDays: number | null;
  autoAssignOnJoin: boolean;
  status: TrainingCourseStatus;
  publishedAt: Date | null;
  archivedAt: Date | null;
  materialCount: number;
  /** People who have it (not counting cancelled), and how many of them have completed it. */
  assignedCount: number;
  completedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Training courses and the materials in them.
 *
 * A course starts as a DRAFT, is PUBLISHED once it has something to learn from,
 * and is ARCHIVED rather than deleted when it is retired, so what people
 * completed stays on record. An archived course is read-only until it is
 * restored. Only a draft can be deleted.
 */
@Injectable()
export class LearningCourseService {
  private readonly logger = new Logger(LearningCourseService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ==========================================
  // Errors and small helpers
  // ==========================================

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private notFound(courseId: string): never {
    this.fail(HttpStatus.NOT_FOUND, `Course '${courseId}' not found in this organization.`);
  }

  /** Trim, drop blanks and repeats (not case-sensitive), keeping the first spelling. */
  private cleanTags(tags: string[] | null | undefined): string[] | undefined {
    if (tags === undefined) return undefined;
    if (tags === null) return [];
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of tags) {
      const tag = raw.trim().replace(/\s+/g, ' ');
      if (!tag) continue;
      if (tag.length > TRAINING_TAG_MAX) this.fail(HttpStatus.BAD_REQUEST, `A tag can be at most ${TRAINING_TAG_MAX} characters.`);
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(tag);
      if (cleaned.length > TRAINING_MAX_TAGS) this.fail(HttpStatus.BAD_REQUEST, `A course can have at most ${TRAINING_MAX_TAGS} tags.`);
    }
    return cleaned;
  }

  /** Only web addresses: a link that runs script, or opens a local file, is not a learning resource. */
  private cleanUrl(value: string): string {
    const text = value.trim();
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      this.fail(HttpStatus.BAD_REQUEST, 'Enter a full web address, starting with http:// or https://.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.fail(HttpStatus.BAD_REQUEST, 'Enter a full web address, starting with http:// or https://.');
    }
    return text;
  }

  private async assertTitleFree(tenantId: string, title: string, exceptId?: string) {
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const clash = await Course.findOne({
      where: { tenantId, title: { [Op.iLike]: ESCAPE(title) }, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
      attributes: ['id'],
    });
    if (clash) this.fail(HttpStatus.CONFLICT, `A course titled '${title}' already exists.`);
  }

  private toMaterialRow(courseId: string, material: any): TrainingMaterialRow {
    return {
      id: material.id,
      kind: material.kind,
      title: material.title,
      url: material.url ?? null,
      fileName: material.fileName ?? null,
      mimeType: material.mimeType ?? null,
      sizeBytes: material.sizeBytes === null || material.sizeBytes === undefined ? null : Number(material.sizeBytes),
      required: material.required !== false,
      sortOrder: Number(material.sortOrder ?? 0),
      downloadPath: material.kind === TrainingMaterialKind.FILE ? `/organization/learning/courses/${courseId}/materials/${material.id}/download` : null,
    };
  }

  private toRow(course: any, materialCount: number, counts: { assigned: number; completed: number } = { assigned: 0, completed: 0 }): TrainingCourseRow {
    return {
      id: course.id,
      title: course.title,
      description: course.description ?? null,
      category: course.category ?? null,
      tags: Array.isArray(course.tags) ? course.tags : [],
      mandatoryByDefault: course.mandatoryByDefault === true,
      estimatedMinutes: course.estimatedMinutes ?? null,
      requireAllMaterials: course.requireAllMaterials === true,
      defaultDueDays: course.defaultDueDays ?? null,
      autoAssignOnJoin: course.autoAssignOnJoin === true,
      status: course.status,
      publishedAt: course.publishedAt ?? null,
      archivedAt: course.archivedAt ?? null,
      materialCount,
      assignedCount: counts.assigned,
      completedCount: counts.completed,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
    };
  }

  private async load(tenantId: string, courseId: string) {
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const course: any = await Course.findOne({ where: { id: courseId, tenantId } });
    if (!course) this.notFound(courseId);
    return course;
  }

  /** An archived course is read-only: restore it to change it. */
  private assertEditable(course: any) {
    if (course.status === TrainingCourseStatus.ARCHIVED) {
      this.fail(HttpStatus.CONFLICT, 'This course is archived. Restore it before changing it.');
    }
  }

  private async materialsOf(tenantId: string, courseId: string): Promise<any[]> {
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    return (await Material.findAll({ where: { tenantId, courseId }, order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']] })) as any[];
  }

  private async detail(tenantId: string, courseId: string) {
    const course = await this.load(tenantId, courseId);
    const materials = await this.materialsOf(tenantId, courseId);
    const Assignment = await this.modelProvider.getTrainingAssignmentModel(tenantId);
    const [assigned, completed] = await Promise.all([
      Assignment.count({ where: { tenantId, courseId, status: { [Op.ne]: 'CANCELLED' } } }),
      Assignment.count({ where: { tenantId, courseId, status: 'COMPLETED' } }),
    ]);
    return {
      ...this.toRow(course, materials.length, { assigned, completed }),
      materials: materials.map((material) => this.toMaterialRow(courseId, material)),
    };
  }

  // ==========================================
  // Reading courses
  // ==========================================

  /** The course list: searched, filtered, sorted and paged, with how many courses are in each state. */
  async getCourses(tenantId: string, query: GetTrainingCoursesQueryDto = {}) {
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const where: Record<string | symbol, unknown> = { tenantId };
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.category) where.category = { [Op.iLike]: ESCAPE(query.category.trim()) };
    if (query.mandatory !== undefined) where.mandatoryByDefault = query.mandatory;
    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      where[Op.or] = [{ title: { [Op.iLike]: like } }, { description: { [Op.iLike]: like } }, { category: { [Op.iLike]: like } }];
    }

    const direction = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const order: any[] =
      query.sortBy === 'title'
        ? [['title', direction]]
        : query.sortBy === 'status'
          ? [['status', direction], ['title', 'ASC']]
          : [['createdAt', direction], ['id', 'ASC']];

    const [{ rows, count }, byStatus] = await Promise.all([
      Course.findAndCountAll({
        where: where as any,
        attributes: {
          include: [
            [literal('(SELECT COUNT(*)::int FROM training_materials AS m WHERE m."courseId" = "TrainingCourse"."id")'), 'materialCount'],
            [literal(`(SELECT COUNT(*)::int FROM training_assignments AS a WHERE a."courseId" = "TrainingCourse"."id" AND a.status <> 'CANCELLED')`), 'assignedCount'],
            [literal(`(SELECT COUNT(*)::int FROM training_assignments AS a WHERE a."courseId" = "TrainingCourse"."id" AND a.status = 'COMPLETED')`), 'completedCount'],
          ],
        },
        order,
        limit,
        offset: (page - 1) * limit,
      }),
      Course.sequelize!.query(`SELECT status, COUNT(*)::int AS "count" FROM training_courses WHERE "tenantId" = :tenantId GROUP BY status`, {
        replacements: { tenantId },
        type: QueryTypes.SELECT,
      }) as Promise<{ status: string; count: number }[]>,
    ]);
    const counts = new Map(byStatus.map((row) => [row.status, Number(row.count)]));

    return {
      data: (rows as any[]).map((course) =>
        this.toRow(course, Number(course.get('materialCount') ?? 0), {
          assigned: Number(course.get('assignedCount') ?? 0),
          completed: Number(course.get('completedCount') ?? 0),
        }),
      ),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: {
        draft: counts.get(TrainingCourseStatus.DRAFT) ?? 0,
        published: counts.get(TrainingCourseStatus.PUBLISHED) ?? 0,
        archived: counts.get(TrainingCourseStatus.ARCHIVED) ?? 0,
      },
    };
  }

  /** The categories in use, for a filter. */
  async getCategories(tenantId: string) {
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const rows = (await Course.sequelize!.query(
      `SELECT category AS "name", COUNT(*)::int AS "courseCount"
         FROM training_courses
        WHERE "tenantId" = :tenantId AND category IS NOT NULL
        GROUP BY category
        ORDER BY category`,
      { replacements: { tenantId }, type: QueryTypes.SELECT },
    )) as { name: string; courseCount: number }[];
    return { data: rows.map((row) => ({ name: row.name, courseCount: Number(row.courseCount) })) };
  }

  async getCourse(tenantId: string, courseId: string) {
    return this.detail(tenantId, courseId);
  }

  // ==========================================
  // Writing courses
  // ==========================================

  async createCourse(actor: LearningActorDto, dto: CreateTrainingCourseDto) {
    const { tenantId } = actor;
    const title = dto.title.trim();
    await this.assertTitleFree(tenantId, title);
    const tags = this.cleanTags(dto.tags) ?? [];

    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    let created: any;
    try {
      created = await Course.create({
        tenantId,
        title,
        description: dto.description ?? null,
        category: dto.category ?? null,
        tags,
        mandatoryByDefault: dto.mandatoryByDefault === true,
        estimatedMinutes: dto.estimatedMinutes ?? null,
        requireAllMaterials: dto.requireAllMaterials === true,
        defaultDueDays: dto.defaultDueDays ?? null,
        autoAssignOnJoin: dto.autoAssignOnJoin === true,
        status: TrainingCourseStatus.DRAFT,
        createdByUserId: actor.userId ?? null,
      } as any);
    } catch (error) {
      if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, `A course titled '${title}' already exists.`);
      throw error;
    }
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', created.id, 'CREATE', {
      title: { from: null, to: title },
      status: { from: null, to: TrainingCourseStatus.DRAFT },
    });
    return this.detail(tenantId, created.id);
  }

  async updateCourse(actor: LearningActorDto, courseId: string, dto: UpdateTrainingCourseDto) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    this.assertEditable(course);

    const title = dto.title?.trim();
    if (title !== undefined && title.toLowerCase() !== String(course.title).toLowerCase()) {
      await this.assertTitleFree(tenantId, title, courseId);
    }
    const tags = this.cleanTags(dto.tags);

    const next: Record<string, unknown> = {
      title,
      description: dto.description,
      category: dto.category,
      tags,
      mandatoryByDefault: dto.mandatoryByDefault,
      estimatedMinutes: dto.estimatedMinutes,
      requireAllMaterials: dto.requireAllMaterials,
      defaultDueDays: dto.defaultDueDays,
      autoAssignOnJoin: dto.autoAssignOnJoin,
    };
    const before = course.get({ plain: true });
    const changes = diffFields(before, next);
    // A tag list written in another order is still the same list.
    if (changes.tags && JSON.stringify(changes.tags.from ?? []) === JSON.stringify(changes.tags.to ?? [])) delete changes.tags;

    if (Object.keys(changes).length) {
      try {
        await course.update(Object.fromEntries(Object.entries(next).filter(([key]) => key in changes)));
      } catch (error) {
        if (error instanceof UniqueConstraintError) this.fail(HttpStatus.CONFLICT, `A course titled '${title}' already exists.`);
        throw error;
      }
      await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', courseId, 'UPDATE', changes);
    }
    return this.detail(tenantId, courseId);
  }

  /** Only a draft: anything that has been published may have been taken, so it is archived instead. */
  async deleteCourse(actor: LearningActorDto, courseId: string) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    if (course.status !== TrainingCourseStatus.DRAFT) {
      this.fail(HttpStatus.CONFLICT, 'Only a draft course can be deleted. Archive this one instead, so its history is kept.');
    }
    await course.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', courseId, 'DELETE', {
      title: { from: course.title, to: null },
    });
    return { deleted: true, id: courseId };
  }

  private async changeStatus(
    actor: LearningActorDto,
    courseId: string,
    allowedFrom: TrainingCourseStatus,
    to: TrainingCourseStatus,
    refusal: (current: string) => string,
    patch: Record<string, unknown>,
  ) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    if (course.status !== allowedFrom) this.fail(HttpStatus.CONFLICT, refusal(course.status));
    return { course, apply: async () => {
      await course.update({ status: to, ...patch });
      await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', courseId, 'UPDATE', {
        status: { from: allowedFrom, to },
      });
      return this.detail(tenantId, courseId);
    } };
  }

  /** A course is published once there is something in it to learn from. */
  async publish(actor: LearningActorDto, courseId: string) {
    const step = await this.changeStatus(
      actor,
      courseId,
      TrainingCourseStatus.DRAFT,
      TrainingCourseStatus.PUBLISHED,
      (current) => (current === TrainingCourseStatus.ARCHIVED ? 'This course is archived. Restore it instead.' : 'This course is already published.'),
      { publishedAt: new Date(), archivedAt: null },
    );
    const materials = await this.materialsOf(actor.tenantId, courseId);
    if (!materials.length) this.fail(HttpStatus.CONFLICT, 'Add at least one material before publishing the course.');
    return step.apply();
  }

  async archive(actor: LearningActorDto, courseId: string) {
    const step = await this.changeStatus(
      actor,
      courseId,
      TrainingCourseStatus.PUBLISHED,
      TrainingCourseStatus.ARCHIVED,
      (current) => (current === TrainingCourseStatus.ARCHIVED ? 'This course is already archived.' : 'Only a published course can be archived. Delete a draft instead.'),
      { archivedAt: new Date() },
    );
    return step.apply();
  }

  async unarchive(actor: LearningActorDto, courseId: string) {
    const step = await this.changeStatus(
      actor,
      courseId,
      TrainingCourseStatus.ARCHIVED,
      TrainingCourseStatus.PUBLISHED,
      () => 'Only an archived course can be restored.',
      { archivedAt: null },
    );
    return step.apply();
  }

  /** A copy as a draft, with the same settings and materials, titled "X Copy", "X Copy 2"… */
  async duplicate(actor: LearningActorDto, courseId: string) {
    const { tenantId } = actor;
    const source = await this.load(tenantId, courseId);
    const Course = await this.modelProvider.getTrainingCourseModel(tenantId);
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);

    const base = String(source.title).slice(0, TITLE_MAX - 10);
    const taken = (
      (await Course.findAll({ where: { tenantId, title: { [Op.iLike]: `${ESCAPE(base)} Copy%` } }, attributes: ['title'], raw: true })) as unknown as {
        title: string;
      }[]
    ).map((row) => row.title.toLowerCase());
    let title = `${base} Copy`;
    for (let attempt = 2; taken.includes(title.toLowerCase()) && attempt <= COPY_ATTEMPTS; attempt++) title = `${base} Copy ${attempt}`;

    const materials = await this.materialsOf(tenantId, courseId);
    const createdId = await Course.sequelize!.transaction(async (transaction) => {
      const created: any = await Course.create(
        {
          tenantId,
          title,
          description: source.description,
          category: source.category,
          tags: source.tags ?? [],
          mandatoryByDefault: source.mandatoryByDefault,
          estimatedMinutes: source.estimatedMinutes,
          requireAllMaterials: source.requireAllMaterials,
          defaultDueDays: source.defaultDueDays,
          autoAssignOnJoin: source.autoAssignOnJoin,
          status: TrainingCourseStatus.DRAFT,
          createdByUserId: actor.userId ?? null,
        } as any,
        { transaction },
      );
      if (materials.length) {
        await Material.bulkCreate(
          materials.map((material) => ({
            tenantId,
            courseId: created.id,
            kind: material.kind,
            title: material.title,
            url: material.url,
            fileId: material.fileId,
            fileName: material.fileName,
            mimeType: material.mimeType,
            sizeBytes: material.sizeBytes,
            sortOrder: material.sortOrder,
            required: material.required,
          })) as any[],
          { transaction },
        );
      }
      return created.id as string;
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', createdId, 'CREATE', {
      title: { from: null, to: title },
      copiedFrom: { from: null, to: courseId },
    });
    return this.detail(tenantId, createdId);
  }

  // ==========================================
  // Materials
  // ==========================================

  private async auditMaterial(tenantId: string, courseId: string, what: string) {
    await writeAudit(this.modelProvider, this.logger, tenantId, 'training_courses', courseId, 'UPDATE', {
      materials: { from: null, to: what },
    });
  }

  /** A file needs the file store's facts about it; a link needs a web address. Never both. */
  async addMaterial(actor: LearningActorDto, courseId: string, dto: AddTrainingMaterialDto, file?: TrainingFileDto) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    this.assertEditable(course);

    let fields: { url: string | null; fileId: string | null; fileName: string | null; mimeType: string | null; sizeBytes: number | null };
    if (dto.kind === TrainingMaterialKind.FILE) {
      if (dto.url) this.fail(HttpStatus.BAD_REQUEST, 'A file material has no web address. Remove the url, or choose a link type.');
      if (!dto.fileId || !file || file.fileId !== dto.fileId) {
        this.fail(HttpStatus.BAD_REQUEST, 'Attach a file: upload it first (category "training") and send its fileId.');
      }
      fields = { url: null, fileId: file.fileId, fileName: file.fileName, mimeType: file.mimeType ?? null, sizeBytes: file.sizeBytes };
    } else {
      if (dto.fileId) this.fail(HttpStatus.BAD_REQUEST, 'A link material has no file. Remove the fileId, or choose the file type.');
      if (!dto.url) this.fail(HttpStatus.BAD_REQUEST, 'Enter the web address of the resource.');
      fields = { url: this.cleanUrl(dto.url), fileId: null, fileName: null, mimeType: null, sizeBytes: null };
    }

    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    const count = await Material.count({ where: { tenantId, courseId } });
    if (count >= TRAINING_MAX_MATERIALS) {
      this.fail(HttpStatus.BAD_REQUEST, `A course can have at most ${TRAINING_MAX_MATERIALS} materials.`);
    }
    const last: any = await Material.findOne({ where: { tenantId, courseId }, order: [['sortOrder', 'DESC']], attributes: ['sortOrder'] });

    const created: any = await Material.create({
      tenantId,
      courseId,
      kind: dto.kind,
      title: dto.title.trim(),
      ...fields,
      sortOrder: (last?.sortOrder ?? -1) + 1,
      required: dto.required !== false,
    } as any);
    await this.auditMaterial(tenantId, courseId, `added '${created.title}'`);
    return this.detail(tenantId, courseId);
  }

  private async loadMaterial(tenantId: string, courseId: string, materialId: string) {
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    const material: any = await Material.findOne({ where: { id: materialId, courseId, tenantId } });
    if (!material) this.fail(HttpStatus.NOT_FOUND, `Material '${materialId}' not found in this course.`);
    return material;
  }

  async updateMaterial(actor: LearningActorDto, courseId: string, materialId: string, dto: UpdateTrainingMaterialDto) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    this.assertEditable(course);
    const material = await this.loadMaterial(tenantId, courseId, materialId);

    const patch: Record<string, unknown> = {};
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.required !== undefined) patch.required = dto.required;
    if (dto.url !== undefined) {
      if (material.kind === TrainingMaterialKind.FILE) {
        this.fail(HttpStatus.BAD_REQUEST, 'A file material has no web address. Remove it and add the new file instead.');
      }
      patch.url = this.cleanUrl(dto.url);
    }
    if (Object.keys(patch).length) {
      await material.update(patch);
      await this.auditMaterial(tenantId, courseId, `changed '${material.title}'`);
    }
    return this.detail(tenantId, courseId);
  }

  /** A published course keeps at least one material, so it never goes out empty. */
  async deleteMaterial(actor: LearningActorDto, courseId: string, materialId: string) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    this.assertEditable(course);
    const material = await this.loadMaterial(tenantId, courseId, materialId);

    if (course.status === TrainingCourseStatus.PUBLISHED) {
      const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
      if ((await Material.count({ where: { tenantId, courseId } })) <= 1) {
        this.fail(HttpStatus.CONFLICT, 'A published course needs at least one material. Add another one first, or archive the course.');
      }
    }
    await material.destroy();
    await this.auditMaterial(tenantId, courseId, `removed '${material.title}'`);
    return this.detail(tenantId, courseId);
  }

  /** The order has to name every material of the course, once each. */
  async setMaterialOrder(actor: LearningActorDto, courseId: string, dto: SetTrainingMaterialOrderDto) {
    const { tenantId } = actor;
    const course = await this.load(tenantId, courseId);
    this.assertEditable(course);
    const materials = await this.materialsOf(tenantId, courseId);

    const existing = new Set(materials.map((material) => material.id));
    if (dto.materialIds.length !== existing.size || dto.materialIds.some((id) => !existing.has(id))) {
      this.fail(HttpStatus.BAD_REQUEST, 'List every material of this course, once each.');
    }
    const Material = await this.modelProvider.getTrainingMaterialModel(tenantId);
    await Material.sequelize!.transaction(async (transaction) => {
      for (const [index, id] of dto.materialIds.entries()) {
        await Material.update({ sortOrder: index } as any, { where: { id, courseId, tenantId }, transaction });
      }
    });
    await this.auditMaterial(tenantId, courseId, 'reordered');
    return this.detail(tenantId, courseId);
  }

  /** The stored file behind a file material, for previewing it. A link has nothing to download. */
  async getMaterialFile(tenantId: string, courseId: string, materialId: string) {
    await this.load(tenantId, courseId);
    const material = await this.loadMaterial(tenantId, courseId, materialId);
    if (material.kind !== TrainingMaterialKind.FILE || !material.fileId) {
      this.fail(HttpStatus.BAD_REQUEST, 'This material is a link. Open it at its web address.');
    }
    return { fileId: material.fileId as string, fileName: material.fileName as string, mimeType: (material.mimeType ?? null) as string | null };
  }
}
