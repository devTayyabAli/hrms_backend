import { Op, UniqueConstraintError } from 'sequelize';
import { TrainingCourseStatus, TrainingMaterialKind } from '@app/common';
import { LearningCourseService } from './learning-course.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const M1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const M2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const M3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const FILE = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const actor = { tenantId: TENANT, userId: 'user-1', email: 'hr@example.com' };

/** A Sequelize-like row: `update` writes back, `get({plain})` returns the values. */
const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  r.destroy = jest.fn().mockResolvedValue(undefined);
  r.get = jest.fn((options?: any) => (options?.plain ? { ...r } : r[options]));
  return r;
};

const course = (over: Record<string, any> = {}) =>
  row({
    id: COURSE,
    tenantId: TENANT,
    title: 'Workplace Safety',
    description: 'Basics',
    category: 'Compliance',
    tags: ['safety'],
    mandatoryByDefault: true,
    estimatedMinutes: 45,
    requireAllMaterials: false,
    defaultDueDays: 14,
    autoAssignOnJoin: false,
    status: TrainingCourseStatus.DRAFT,
    publishedAt: null,
    archivedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  });

const material = (over: Record<string, any> = {}) =>
  row({
    id: M1,
    tenantId: TENANT,
    courseId: COURSE,
    kind: TrainingMaterialKind.LINK,
    title: 'Handbook site',
    url: 'https://example.com/handbook',
    fileId: null,
    fileName: null,
    mimeType: null,
    sizeBytes: null,
    required: true,
    sortOrder: 0,
    createdAt: new Date(),
    ...over,
  });

describe('LearningCourseService', () => {
  let courseModel: any;
  let materialModel: any;
  let assignmentModel: { count: jest.Mock };
  let auditModel: { create: jest.Mock };
  let sequelize: any;
  let service: LearningCourseService;

  /** What the next read of the course (and its materials) returns. */
  const stored = (c: any, materials: any[] = []) => {
    courseModel.findOne.mockImplementation(async ({ where }: any) => (where.title ? null : c));
    materialModel.findAll.mockResolvedValue(materials);
    materialModel.count.mockResolvedValue(materials.length);
  };

  const audited = () => auditModel.create.mock.calls.map((call: any[]) => call[0]);

  beforeEach(() => {
    sequelize = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (work: (t: unknown) => unknown) => work('tx')),
    };
    courseModel = {
      sequelize,
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      create: jest.fn(async (values: any) => course({ id: COURSE, ...values })),
    };
    materialModel = {
      sequelize,
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async (values: any) => material({ id: M2, ...values })),
      bulkCreate: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue([1]),
    };
    assignmentModel = { count: jest.fn().mockResolvedValue(0) };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getTrainingCourseModel: jest.fn().mockResolvedValue(courseModel),
      getTrainingMaterialModel: jest.fn().mockResolvedValue(materialModel),
      getTrainingAssignmentModel: jest.fn().mockResolvedValue(assignmentModel),
      getEntityAuditLogModel: jest.fn().mockResolvedValue(auditModel),
    };
    service = new LearningCourseService(provider);
  });

  describe('creating a course', () => {
    it('starts it as a draft, tidying the title and tags, and records it', async () => {
      const created = course({ id: COURSE });
      courseModel.create.mockResolvedValue(created);
      courseModel.findOne.mockImplementation(async ({ where }: any) => (where.title ? null : created));

      await service.createCourse(actor, {
        title: '  Workplace Safety  ',
        tags: [' safety ', 'Safety', '', 'first   aid'],
        mandatoryByDefault: true,
        estimatedMinutes: 45,
      });

      expect(courseModel.create.mock.calls[0][0]).toMatchObject({
        tenantId: TENANT,
        title: 'Workplace Safety',
        status: 'DRAFT',
        tags: ['safety', 'first aid'],
        mandatoryByDefault: true,
        estimatedMinutes: 45,
        requireAllMaterials: false,
        autoAssignOnJoin: false,
        createdByUserId: 'user-1',
      });
      expect(audited()).toEqual([
        expect.objectContaining({ tableName: 'training_courses', action: 'CREATE', changes: expect.objectContaining({ title: { from: null, to: 'Workplace Safety' } }) }),
      ]);
    });

    it('refuses a title that is taken, ignoring case', async () => {
      courseModel.findOne.mockResolvedValue({ id: 'other' });

      await expect(service.createCourse(actor, { title: 'workplace safety' })).rejects.toMatchObject({ status: 409 });
      expect(courseModel.create).not.toHaveBeenCalled();
    });

    it('refuses a title that races another save', async () => {
      courseModel.create.mockRejectedValue(new UniqueConstraintError({ errors: [] } as any));

      await expect(service.createCourse(actor, { title: 'Safety' })).rejects.toMatchObject({ status: 409 });
    });

    it('refuses a tag that is too long', async () => {
      await expect(service.createCourse(actor, { title: 'Safety', tags: ['x'.repeat(41)] })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('the course list', () => {
    it('pages and maps courses with how many materials each has, and counts every state', async () => {
      courseModel.findAndCountAll.mockResolvedValue({
        count: 23,
        rows: [course()].map((c) => {
          const counts: Record<string, number> = { materialCount: 3, assignedCount: 12, completedCount: 5 };
          c.get = jest.fn((key: string) => counts[key]);
          return c;
        }),
      });
      sequelize.query.mockResolvedValue([
        { status: 'DRAFT', count: 4 },
        { status: 'PUBLISHED', count: 17 },
      ]);

      const result = await service.getCourses(TENANT, { page: 3, limit: 10 });

      expect(courseModel.findAndCountAll.mock.calls[0][0]).toMatchObject({ limit: 10, offset: 20 });
      expect(result).toMatchObject({ total: 23, page: 3, limit: 10, totalPages: 3, summary: { draft: 4, published: 17, archived: 0 } });
      expect(result.data[0]).toMatchObject({ id: COURSE, title: 'Workplace Safety', tags: ['safety'], materialCount: 3, assignedCount: 12, completedCount: 5, status: 'DRAFT' });
    });

    it('filters by status, category and mandatory, and searches the title, description and category', async () => {
      await service.getCourses(TENANT, { status: 'PUBLISHED' as any, category: 'Compliance', mandatory: false, search: '50%_off' });

      const where = courseModel.findAndCountAll.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT, status: 'PUBLISHED', mandatoryByDefault: false });
      expect(where.category[Op.iLike]).toBe('Compliance');
      expect(where[Op.or].map((clause: any) => Object.keys(clause)[0])).toEqual(['title', 'description', 'category']);
      expect(where[Op.or][0].title[Op.iLike]).toBe('%50\\%\\_off%');
    });

    it('does not filter on status for ALL, and sorts as asked', async () => {
      await service.getCourses(TENANT, { status: 'ALL' as any, sortBy: 'title', sortOrder: 'asc' });
      expect(courseModel.findAndCountAll.mock.calls[0][0].where.status).toBeUndefined();
      expect(courseModel.findAndCountAll.mock.calls[0][0].order).toEqual([['title', 'ASC']]);

      await service.getCourses(TENANT, { sortBy: 'status', sortOrder: 'desc' });
      expect(courseModel.findAndCountAll.mock.calls[1][0].order).toEqual([['status', 'DESC'], ['title', 'ASC']]);
    });

    it('lists the categories in use', async () => {
      sequelize.query.mockResolvedValue([{ name: 'Compliance', courseCount: 3 }, { name: 'Induction', courseCount: '1' }]);

      await expect(service.getCategories(TENANT)).resolves.toEqual({
        data: [{ name: 'Compliance', courseCount: 3 }, { name: 'Induction', courseCount: 1 }],
      });
    });
  });

  describe('one course', () => {
    it('comes with its materials in order, a file with its size and where to download it', async () => {
      stored(course(), [
        material({ id: M1, sortOrder: 0 }),
        material({ id: M2, kind: 'FILE', title: 'Handbook', url: null, fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf', sizeBytes: '245760', sortOrder: 1 }),
      ]);

      assignmentModel.count.mockImplementation(async ({ where }: any) => (where.status === 'COMPLETED' ? 4 : 9));

      const result = await service.getCourse(TENANT, COURSE);

      expect(result.materialCount).toBe(2);
      expect(result).toMatchObject({ assignedCount: 9, completedCount: 4 });
      expect(result.materials[0]).toMatchObject({ kind: 'LINK', url: 'https://example.com/handbook', downloadPath: null, required: true });
      expect(result.materials[1]).toMatchObject({
        kind: 'FILE',
        fileName: 'handbook.pdf',
        sizeBytes: 245760,
        downloadPath: `/organization/learning/courses/${COURSE}/materials/${M2}/download`,
      });
    });

    it('404s for a course that is not in this organization', async () => {
      await expect(service.getCourse(TENANT, COURSE)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('editing a course', () => {
    it('saves and records only what changed', async () => {
      const c = course();
      stored(c);

      await service.updateCourse(actor, COURSE, { title: 'Workplace Safety', estimatedMinutes: 60, description: null, category: 'Compliance' });

      expect(c.update).toHaveBeenCalledWith({ estimatedMinutes: 60, description: null });
      expect(audited()).toEqual([
        expect.objectContaining({ action: 'UPDATE', changes: expect.objectContaining({ estimatedMinutes: { from: 45, to: 60 }, description: { from: 'Basics', to: null } }) }),
      ]);
    });

    it('does nothing, and records nothing, when nothing changed', async () => {
      const c = course();
      stored(c);

      await service.updateCourse(actor, COURSE, { title: 'Workplace Safety', tags: ['safety'], mandatoryByDefault: true });

      expect(c.update).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it('refuses a new title that is taken', async () => {
      stored(course());
      courseModel.findOne.mockImplementation(async ({ where }: any) => (where.title ? { id: 'other' } : course()));

      await expect(service.updateCourse(actor, COURSE, { title: 'Induction' })).rejects.toMatchObject({ status: 409 });
    });

    it('will not edit an archived course', async () => {
      stored(course({ status: 'ARCHIVED' }));

      await expect(service.updateCourse(actor, COURSE, { title: 'New' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Restore') });
    });
  });

  describe('deleting, publishing and archiving', () => {
    it('deletes a draft', async () => {
      const c = course();
      stored(c);

      await expect(service.deleteCourse(actor, COURSE)).resolves.toEqual({ deleted: true, id: COURSE });
      expect(c.destroy).toHaveBeenCalled();
      expect(audited()[0]).toMatchObject({ action: 'DELETE' });
    });

    it('will not delete a course that has been published, or archived', async () => {
      for (const status of ['PUBLISHED', 'ARCHIVED']) {
        const c = course({ status });
        stored(c);
        await expect(service.deleteCourse(actor, COURSE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Archive') });
        expect(c.destroy).not.toHaveBeenCalled();
      }
    });

    it('publishes a draft that has a material, and stamps when', async () => {
      const c = course();
      stored(c, [material()]);

      await service.publish(actor, COURSE);

      const patch = c.update.mock.calls[0][0];
      expect(patch).toMatchObject({ status: 'PUBLISHED', archivedAt: null });
      expect(patch.publishedAt).toBeInstanceOf(Date);
      expect(audited()[0]).toMatchObject({ changes: expect.objectContaining({ status: { from: 'DRAFT', to: 'PUBLISHED' } }) });
    });

    it('will not publish a course with nothing in it', async () => {
      const c = course();
      stored(c, []);

      await expect(service.publish(actor, COURSE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('at least one material') });
      expect(c.update).not.toHaveBeenCalled();
    });

    it('will not publish one that is already published, and points an archived one to restore', async () => {
      stored(course({ status: 'PUBLISHED' }), [material()]);
      await expect(service.publish(actor, COURSE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already published') });

      stored(course({ status: 'ARCHIVED' }), [material()]);
      await expect(service.publish(actor, COURSE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Restore') });
    });

    it('archives a published course and restores an archived one', async () => {
      const live = course({ status: 'PUBLISHED' });
      stored(live, [material()]);
      await service.archive(actor, COURSE);
      expect(live.update.mock.calls[0][0]).toMatchObject({ status: 'ARCHIVED' });
      expect(live.update.mock.calls[0][0].archivedAt).toBeInstanceOf(Date);

      const old = course({ status: 'ARCHIVED', archivedAt: new Date() });
      stored(old, [material()]);
      await service.unarchive(actor, COURSE);
      expect(old.update.mock.calls[0][0]).toEqual({ status: 'PUBLISHED', archivedAt: null });
    });

    it('will not archive a draft, or restore one that is not archived', async () => {
      stored(course(), [material()]);
      await expect(service.archive(actor, COURSE)).rejects.toMatchObject({ status: 409 });
      stored(course({ status: 'PUBLISHED' }), [material()]);
      await expect(service.unarchive(actor, COURSE)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('duplicating a course', () => {
    it('makes a draft copy with the same settings and materials', async () => {
      const source = course({ status: 'PUBLISHED', autoAssignOnJoin: true, requireAllMaterials: true });
      const created = course({ id: 'copy-id', title: 'Workplace Safety Copy' });
      courseModel.findOne.mockImplementation(async ({ where }: any) => (where.id === 'copy-id' ? created : source));
      courseModel.create.mockResolvedValue(created);
      materialModel.findAll.mockResolvedValue([material({ id: M1, sortOrder: 0 }), material({ id: M2, sortOrder: 1, title: 'Second' })]);
      materialModel.count.mockResolvedValue(2);

      await service.duplicate(actor, COURSE);

      expect(courseModel.create.mock.calls[0][0]).toMatchObject({
        title: 'Workplace Safety Copy',
        status: 'DRAFT',
        autoAssignOnJoin: true,
        requireAllMaterials: true,
        mandatoryByDefault: true,
        category: 'Compliance',
      });
      const copies = materialModel.bulkCreate.mock.calls[0][0];
      expect(copies.map((copy: any) => [copy.courseId, copy.title, copy.sortOrder])).toEqual([['copy-id', 'Handbook site', 0], ['copy-id', 'Second', 1]]);
      expect(copies.every((copy: any) => copy.id === undefined)).toBe(true);
      expect(audited()[0]).toMatchObject({ changes: expect.objectContaining({ copiedFrom: { from: null, to: COURSE } }) });
    });

    it('numbers the copy when "Copy" is taken', async () => {
      const source = course();
      courseModel.findOne.mockResolvedValue(source);
      courseModel.findAll.mockResolvedValue([{ title: 'Workplace Safety Copy' }, { title: 'workplace safety copy 2' }]);

      await service.duplicate(actor, COURSE);

      expect(courseModel.create.mock.calls[0][0].title).toBe('Workplace Safety Copy 3');
    });
  });

  describe('adding a material', () => {
    const file = { fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf', sizeBytes: 245760 };

    it('attaches a file with the file store\'s own facts, after the last material', async () => {
      stored(course());
      materialModel.findOne.mockResolvedValue({ sortOrder: 4 });

      await service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.FILE, title: ' Handbook ', fileId: FILE }, file);

      expect(materialModel.create.mock.calls[0][0]).toMatchObject({
        courseId: COURSE,
        kind: 'FILE',
        title: 'Handbook',
        fileId: FILE,
        fileName: 'handbook.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 245760,
        url: null,
        sortOrder: 5,
        required: true,
      });
      expect(audited()[0]).toMatchObject({ changes: { materials: { from: null, to: "added 'Handbook'" } } });
    });

    it('needs the file for a file material, and not a web address', async () => {
      stored(course());

      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.FILE, title: 'x' })).rejects.toMatchObject({ status: 400 });
      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.FILE, title: 'x', fileId: FILE }, { ...file, fileId: M1 })).rejects.toMatchObject({ status: 400 });
      await expect(
        service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.FILE, title: 'x', fileId: FILE, url: 'https://example.com' }, file),
      ).rejects.toMatchObject({ status: 400 });
      expect(materialModel.create).not.toHaveBeenCalled();
    });

    it('takes a web address for a link, and nothing else', async () => {
      stored(course());

      await service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.VIDEO_LINK, title: 'Intro', url: ' https://www.youtube.com/watch?v=abc ', required: false });

      expect(materialModel.create.mock.calls[0][0]).toMatchObject({ kind: 'VIDEO_LINK', url: 'https://www.youtube.com/watch?v=abc', fileId: null, required: false, sortOrder: 0 });
      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.LINK, title: 'x', url: 'https://a.com', fileId: FILE })).rejects.toMatchObject({ status: 400 });
      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.LINK, title: 'x' })).rejects.toMatchObject({ status: 400 });
    });

    it.each(['javascript:alert(1)', 'ftp://files.example.com/a.pdf', 'file:///etc/passwd', 'handbook', '//example.com'])('refuses the address %s', async (url) => {
      stored(course());

      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.LINK, title: 'x', url })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('http'),
      });
      expect(materialModel.create).not.toHaveBeenCalled();
    });

    it('stops at 30 materials, and will not touch an archived course', async () => {
      stored(course());
      materialModel.count.mockResolvedValue(30);
      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.LINK, title: 'x', url: 'https://a.com' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('30') });

      stored(course({ status: 'ARCHIVED' }));
      await expect(service.addMaterial(actor, COURSE, { kind: TrainingMaterialKind.LINK, title: 'x', url: 'https://a.com' })).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('changing and removing a material', () => {
    it('edits a link\'s title, address and whether it is required', async () => {
      const m = material();
      stored(course(), [m]);
      materialModel.findOne.mockResolvedValue(m);

      await service.updateMaterial(actor, COURSE, M1, { title: ' New title ', url: 'https://example.com/new', required: false });

      expect(m.update).toHaveBeenCalledWith({ title: 'New title', url: 'https://example.com/new', required: false });
    });

    it('gives a file no address, and checks a link\'s', async () => {
      const file = material({ kind: 'FILE', url: null, fileId: FILE });
      stored(course(), [file]);
      materialModel.findOne.mockResolvedValue(file);
      await expect(service.updateMaterial(actor, COURSE, M1, { url: 'https://example.com' })).rejects.toMatchObject({ status: 400 });

      const link = material();
      materialModel.findOne.mockResolvedValue(link);
      await expect(service.updateMaterial(actor, COURSE, M1, { url: 'javascript:alert(1)' })).rejects.toMatchObject({ status: 400 });
    });

    it('404s for a material that is not in this course', async () => {
      stored(course());

      await expect(service.updateMaterial(actor, COURSE, M1, { title: 'x' })).rejects.toMatchObject({ status: 404 });
    });

    it('removes a material, but a published course keeps its last one', async () => {
      const m = material();
      stored(course({ status: 'PUBLISHED' }), [m, material({ id: M2 })]);
      materialModel.findOne.mockResolvedValue(m);
      await service.deleteMaterial(actor, COURSE, M1);
      expect(m.destroy).toHaveBeenCalled();

      const last = material();
      stored(course({ status: 'PUBLISHED' }), [last]);
      materialModel.findOne.mockResolvedValue(last);
      await expect(service.deleteMaterial(actor, COURSE, M1)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('at least one material') });
      expect(last.destroy).not.toHaveBeenCalled();
    });

    it('lets a draft lose its last material', async () => {
      const last = material();
      stored(course(), [last]);
      materialModel.findOne.mockResolvedValue(last);

      await service.deleteMaterial(actor, COURSE, M1);

      expect(last.destroy).toHaveBeenCalled();
    });
  });

  describe('ordering the materials', () => {
    it('sets the order from the list given', async () => {
      stored(course(), [material({ id: M1 }), material({ id: M2 }), material({ id: M3 })]);

      await service.setMaterialOrder(actor, COURSE, { materialIds: [M3, M1, M2] });

      expect(materialModel.update.mock.calls.map((call: any[]) => [call[1].where.id, call[0].sortOrder])).toEqual([[M3, 0], [M1, 1], [M2, 2]]);
    });

    it('needs every material of the course, once each', async () => {
      stored(course(), [material({ id: M1 }), material({ id: M2 })]);

      await expect(service.setMaterialOrder(actor, COURSE, { materialIds: [M1] })).rejects.toMatchObject({ status: 400 });
      await expect(service.setMaterialOrder(actor, COURSE, { materialIds: [M1, M3] })).rejects.toMatchObject({ status: 400 });
      expect(materialModel.update).not.toHaveBeenCalled();
    });
  });

  describe('previewing a file', () => {
    it('names the stored file behind a file material', async () => {
      stored(course());
      materialModel.findOne.mockResolvedValue(material({ kind: 'FILE', fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf' }));

      await expect(service.getMaterialFile(TENANT, COURSE, M1)).resolves.toEqual({ fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf' });
    });

    it('has nothing to download for a link', async () => {
      stored(course());
      materialModel.findOne.mockResolvedValue(material());

      await expect(service.getMaterialFile(TENANT, COURSE, M1)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('link') });
    });
  });
});
