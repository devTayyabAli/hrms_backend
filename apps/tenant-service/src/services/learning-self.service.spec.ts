import { Op, UniqueConstraintError } from 'sequelize';
import { LearningSelfService } from './learning-self.service';
import { todayIso } from './workspace-shared';
import { addDays } from './learning-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ASSIGNMENT = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const M1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const M2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const FILE = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const actor = { tenantId: TENANT, userId: 'user-anna', email: 'anna@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const assignment = (over: Record<string, any> = {}) =>
  row({
    id: ASSIGNMENT,
    tenantId: TENANT,
    courseId: COURSE,
    courseTitle: 'Workplace Safety',
    employeeId: ANNA,
    source: 'DIRECT',
    mandatory: true,
    dueDate: addDays(todayIso(), 10),
    status: 'NOT_STARTED',
    startedAt: null,
    completedAt: null,
    completionNote: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    course: { id: COURSE, title: 'Workplace Safety', category: 'Compliance', description: 'Basics', estimatedMinutes: 45, requireAllMaterials: false },
    ...over,
  });

const material = (over: Record<string, any> = {}) => ({
  id: M1,
  kind: 'LINK',
  title: 'Handbook site',
  url: 'https://example.com',
  fileId: null,
  fileName: null,
  mimeType: null,
  sizeBytes: null,
  required: true,
  ...over,
});

describe('LearningSelfService', () => {
  const today = todayIso();
  let employeeModel: any;
  let assignmentModel: any;
  let materialModel: any;
  let progressModel: any;
  let auditModel: { create: jest.Mock };
  let sequelize: any;
  let service: LearningSelfService;

  /** What the employee's open course is, and what is in it. */
  const arrange = (a: any, materials: any[] = [material()], opened: string[] = []) => {
    assignmentModel.findOne.mockResolvedValue(a);
    materialModel.findAll.mockResolvedValue(materials);
    materialModel.findOne.mockImplementation(async ({ where }: any) => materials.find((m) => m.id === where.id) ?? null);
    progressModel.findAll.mockResolvedValue(opened.map((materialId) => ({ materialId, openedAt: new Date('2026-11-02T09:00:00Z') })));
    return a;
  };

  beforeEach(() => {
    sequelize = { query: jest.fn().mockResolvedValue([]) };
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: ANNA, firstName: 'Anna', lastName: 'Khan' }) };
    assignmentModel = { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn().mockResolvedValue([]), findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }) };
    materialModel = { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    progressModel = {
      sequelize,
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getTrainingAssignmentModel: jest.fn().mockResolvedValue(assignmentModel),
      getTrainingCourseModel: jest.fn().mockResolvedValue({}),
      getTrainingMaterialModel: jest.fn().mockResolvedValue(materialModel),
      getTrainingProgressModel: jest.fn().mockResolvedValue(progressModel),
      getEntityAuditLogModel: jest.fn().mockResolvedValue(auditModel),
    };
    service = new LearningSelfService(provider);
  });

  describe('who is asking', () => {
    it('finds the employee by login id, then by email, and 404s when there is none', async () => {
      employeeModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: ANNA, firstName: 'Anna', lastName: 'Khan' });
      await expect(service.me(actor)).resolves.toMatchObject({ id: ANNA });
      expect(employeeModel.findOne).toHaveBeenCalledTimes(2);

      employeeModel.findOne.mockResolvedValue(null);
      await expect(service.getMine(actor)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('My Learning', () => {
    const mine = () => [
      assignment({ id: 'done', status: 'COMPLETED', completedAt: new Date(`${addDays(today, -2)}T10:00:00Z`), dueDate: addDays(today, -5), courseTitle: 'Done course' }),
      assignment({ id: 'waiting', dueDate: addDays(today, 20), courseTitle: 'Waiting course' }),
      assignment({ id: 'soon', status: 'IN_PROGRESS', dueDate: addDays(today, 2), courseTitle: 'Soon course' }),
      assignment({ id: 'late', dueDate: addDays(today, -4), courseTitle: 'Late course' }),
      assignment({ id: 'open-ended', dueDate: null, mandatory: false, courseTitle: 'No date course' }),
    ];

    it('puts what is overdue first, then what is under way, what is waiting, and what is done', async () => {
      assignmentModel.findAll.mockResolvedValue(mine());

      const result = await service.getMine(actor);

      expect(result.data.map((r) => [r.id, r.status])).toEqual([
        ['late', 'OVERDUE'],
        ['soon', 'IN_PROGRESS'],
        ['waiting', 'NOT_STARTED'],
        ['open-ended', 'NOT_STARTED'],
        ['done', 'COMPLETED'],
      ]);
      expect(result.summary).toEqual({ total: 5, notStarted: 2, inProgress: 1, completed: 1, overdue: 1 });
      expect(assignmentModel.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, employeeId: ANNA, status: { [Op.ne]: 'CANCELLED' } });
    });

    it('shows how far along each course is, and the course itself', async () => {
      assignmentModel.findAll.mockResolvedValue([assignment()]);
      sequelize.query.mockResolvedValueOnce([{ assignmentId: ASSIGNMENT, count: 2 }]).mockResolvedValueOnce([{ courseId: COURSE, count: 3 }]);

      const [first] = (await service.getMine(actor)).data;

      expect(first).toMatchObject({
        progress: { opened: 2, total: 3, percent: 67 },
        course: { id: COURSE, title: 'Workplace Safety', category: 'Compliance', estimatedMinutes: 45 },
        mandatory: true,
        overdueDays: 0,
      });
    });

    it('filters by status or search, while the counts still cover everything', async () => {
      assignmentModel.findAll.mockResolvedValue(mine());

      const overdue = await service.getMine(actor, { status: 'OVERDUE' as any });
      expect(overdue.data.map((r) => r.id)).toEqual(['late']);
      expect(overdue.summary.total).toBe(5);

      const searched = await service.getMine(actor, { search: 'SOON' });
      expect(searched.data.map((r) => r.id)).toEqual(['soon']);

      const byCategory = await service.getMine(actor, { search: 'compliance' });
      expect(byCategory.data).toHaveLength(5);
    });

    it('shows a completed course newest first', async () => {
      assignmentModel.findAll.mockResolvedValue([
        assignment({ id: 'older', status: 'COMPLETED', completedAt: new Date('2026-10-01T00:00:00Z'), dueDate: null }),
        assignment({ id: 'newer', status: 'COMPLETED', completedAt: new Date('2026-10-20T00:00:00Z'), dueDate: null }),
      ]);

      expect((await service.getMine(actor)).data.map((r) => r.id)).toEqual(['newer', 'older']);
    });
  });

  describe('one course', () => {
    it('lists its materials with which I opened, and whether I can finish it', async () => {
      arrange(
        assignment({ course: { id: COURSE, title: 'Workplace Safety', requireAllMaterials: true } }),
        [material({ id: M1, kind: 'FILE', fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf', sizeBytes: '2048', url: null }), material({ id: M2, required: true })],
        [M1],
      );

      const result = await service.getMineOne(actor, ASSIGNMENT);

      expect(result).toMatchObject({ requiresAllMaterials: true, requiredMaterialsLeft: 1, canComplete: false, progress: { opened: 1, total: 2, percent: 50 } });
      expect(result.materials[0]).toMatchObject({ kind: 'FILE', opened: true, sizeBytes: 2048, downloadPath: `/organization/me/learning/${ASSIGNMENT}/materials/${M1}/download` });
      expect(result.materials[1]).toMatchObject({ kind: 'LINK', opened: false, downloadPath: null, url: 'https://example.com' });
    });

    it('can be finished at once when every material is optional, or nothing is required', async () => {
      arrange(assignment({ course: { id: COURSE, title: 'x', requireAllMaterials: true } }), [material({ required: false })], []);
      expect(await service.getMineOne(actor, ASSIGNMENT)).toMatchObject({ requiredMaterialsLeft: 0, canComplete: true });

      arrange(assignment(), [material()], []);
      expect(await service.getMineOne(actor, ASSIGNMENT)).toMatchObject({ requiresAllMaterials: false, requiredMaterialsLeft: 0, canComplete: true });
    });

    it('looks only among my own, uncancelled assignments, so someone else\'s is not found', async () => {
      await expect(service.getMineOne(actor, ASSIGNMENT)).rejects.toMatchObject({ status: 404 });

      expect(assignmentModel.findOne.mock.calls[0][0].where).toEqual({ id: ASSIGNMENT, tenantId: TENANT, employeeId: ANNA, status: { [Op.ne]: 'CANCELLED' } });
    });
  });

  describe('working through a course', () => {
    it('starts the course the first time a material is opened, and notes it', async () => {
      const a = arrange(assignment());

      await service.openMaterial(actor, ASSIGNMENT, M1);

      expect(progressModel.create.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, assignmentId: ASSIGNMENT, materialId: M1 });
      expect(a.update.mock.calls[0][0]).toMatchObject({ status: 'IN_PROGRESS' });
      expect(a.update.mock.calls[0][0].startedAt).toBeInstanceOf(Date);
    });

    it('counts a material once, however often it is opened, and does not restart a course under way', async () => {
      const a = arrange(assignment({ status: 'IN_PROGRESS', startedAt: new Date('2026-11-02') }));
      progressModel.findOne.mockResolvedValue({ id: 'seen' });

      await service.openMaterial(actor, ASSIGNMENT, M1);

      expect(progressModel.create).not.toHaveBeenCalled();
      expect(a.update).not.toHaveBeenCalled();
    });

    it('is fine when the same material is opened twice at once', async () => {
      arrange(assignment());
      progressModel.create.mockRejectedValue(new UniqueConstraintError({ errors: [] } as any));

      await expect(service.openMaterial(actor, ASSIGNMENT, M1)).resolves.toBeDefined();
    });

    it('only opens a material that is in this course', async () => {
      arrange(assignment(), [material()]);

      await expect(service.openMaterial(actor, ASSIGNMENT, M2)).rejects.toMatchObject({ status: 404, message: expect.stringContaining('not in this course') });
      expect(progressModel.create).not.toHaveBeenCalled();
    });

    it('records nothing, and changes nothing, once the course is finished', async () => {
      const a = arrange(assignment({ status: 'COMPLETED', completedAt: new Date() }));

      await service.openMaterial(actor, ASSIGNMENT, M1);

      expect(progressModel.create).not.toHaveBeenCalled();
      expect(a.update).not.toHaveBeenCalled();
    });

    it('starts a course without opening anything, once', async () => {
      const a = arrange(assignment());
      await service.start(actor, ASSIGNMENT);
      expect(a.update.mock.calls[0][0]).toMatchObject({ status: 'IN_PROGRESS' });

      const running = arrange(assignment({ status: 'IN_PROGRESS' }));
      await service.start(actor, ASSIGNMENT);
      expect(running.update).not.toHaveBeenCalled();
    });

    it('downloads a file as opening it, and has nothing to download for a link', async () => {
      const file = material({ kind: 'FILE', fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf', url: null });
      const a = arrange(assignment(), [file]);

      await expect(service.getMaterialFile(actor, ASSIGNMENT, M1)).resolves.toEqual({ fileId: FILE, fileName: 'handbook.pdf', mimeType: 'application/pdf' });
      expect(progressModel.create).toHaveBeenCalled();
      expect(a.update.mock.calls[0][0]).toMatchObject({ status: 'IN_PROGRESS' });

      arrange(assignment(), [material()]);
      await expect(service.getMaterialFile(actor, ASSIGNMENT, M1)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('link') });
    });
  });

  describe('completing a course', () => {
    it('finishes it, keeps the note, starts it if it never was, and records it', async () => {
      const a = arrange(assignment());

      const result = await service.complete(actor, ASSIGNMENT, { note: 'Done, thanks' });

      const patch = a.update.mock.calls[0][0];
      expect(patch).toMatchObject({ status: 'COMPLETED', completionNote: 'Done, thanks' });
      expect(patch.completedAt).toBeInstanceOf(Date);
      expect(patch.startedAt).toBeInstanceOf(Date);
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({
        tableName: 'training_assignments',
        recordId: ASSIGNMENT,
        changes: expect.objectContaining({ status: { from: 'NOT_STARTED', to: 'COMPLETED' } }),
      });
      expect(result.status).toBe('COMPLETED');
    });

    it('tells the notifier so a mandatory course reaches the manager', async () => {
      const notifier = { completed: jest.fn() };
      service = new LearningSelfService((service as any).modelProvider, notifier as any);
      const a = arrange(assignment({ mandatory: true, dueDate: addDays(today, 4) }));

      await service.complete(actor, ASSIGNMENT, {});

      expect(notifier.completed).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ employeeId: a.employeeId, courseTitle: a.courseTitle, mandatory: true, dueDate: addDays(today, 4) }),
      );
    });

    it('can be finished when it is overdue, and is then recorded as finished late', async () => {
      arrange(assignment({ dueDate: addDays(today, -3) }));

      const result = await service.complete(actor, ASSIGNMENT, {});

      expect(result).toMatchObject({ status: 'COMPLETED', completedLate: true, overdueDays: 0 });
      expect(auditModel.create.mock.calls[0][0].changes).toMatchObject({ completedLate: { from: null, to: true } });
    });

    it('is on time when finished by the due date', async () => {
      arrange(assignment({ dueDate: today }));

      expect(await service.complete(actor, ASSIGNMENT, {})).toMatchObject({ completedLate: false });
    });

    it('needs every required material opened first when the course says so, and says how many are left', async () => {
      const a = arrange(
        assignment({ course: { id: COURSE, title: 'x', requireAllMaterials: true } }),
        [material({ id: M1 }), material({ id: M2, required: true }), material({ id: 'm3', required: false })],
        [M1],
      );

      await expect(service.complete(actor, ASSIGNMENT, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('1 left') });
      expect(a.update).not.toHaveBeenCalled();

      progressModel.findAll.mockResolvedValue([M1, M2].map((materialId) => ({ materialId, openedAt: new Date() })));
      await expect(service.complete(actor, ASSIGNMENT, {})).resolves.toMatchObject({ status: 'COMPLETED' });
    });

    it('does not need any when the course does not ask for it', async () => {
      arrange(assignment(), [material()], []);

      await expect(service.complete(actor, ASSIGNMENT, {})).resolves.toMatchObject({ status: 'COMPLETED' });
    });

    it('cannot be finished twice', async () => {
      arrange(assignment({ status: 'COMPLETED', completedAt: new Date() }));

      await expect(service.complete(actor, ASSIGNMENT, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already completed') });
      expect(auditModel.create).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('lists what I completed, newest first, and whether each was late', async () => {
      assignmentModel.findAndCountAll.mockResolvedValue({
        count: 12,
        rows: [
          assignment({ id: 'h1', status: 'COMPLETED', completedAt: new Date('2026-10-20T10:00:00Z'), dueDate: '2026-10-15', completionNote: 'ok' }),
          assignment({ id: 'h2', status: 'COMPLETED', completedAt: new Date('2026-09-01T10:00:00Z'), dueDate: '2026-09-30', mandatory: false }),
        ],
      });

      const result = await service.getHistory(actor, { page: 2, limit: 5 });

      expect(assignmentModel.findAndCountAll.mock.calls[0][0]).toMatchObject({
        where: { tenantId: TENANT, employeeId: ANNA, status: 'COMPLETED' },
        order: [['completedAt', 'DESC'], ['id', 'ASC']],
        limit: 5,
        offset: 5,
      });
      expect(result).toMatchObject({ total: 12, page: 2, limit: 5, totalPages: 3 });
      expect(result.data).toEqual([
        expect.objectContaining({ id: 'h1', courseTitle: 'Workplace Safety', completedLate: true, note: 'ok', mandatory: true }),
        expect.objectContaining({ id: 'h2', completedLate: false, mandatory: false }),
      ]);
    });
  });
});
