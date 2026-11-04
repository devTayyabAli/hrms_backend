import { Op, UniqueConstraintError } from 'sequelize';
import { TrainingCourseStatus } from '@app/common';
import { LearningAssignmentService } from './learning-assignment.service';
import { todayIso } from './workspace-shared';
import { addDays } from './learning-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ASSIGNMENT = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BEN = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const CARA = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const DEPT = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const DESIGNATION = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const actor = { tenantId: TENANT, userId: 'user-1', email: 'hr@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const person = (id: string, first: string, over: Record<string, any> = {}) => ({
  id,
  firstName: first,
  lastName: 'Khan',
  status: 'ACTIVE',
  departmentId: DEPT,
  designationId: DESIGNATION,
  reportingManagerId: 'mgr-1',
  department: { id: DEPT, name: 'Engineering' },
  designation: { id: DESIGNATION, title: 'Developer' },
  ...over,
});

const course = (over: Record<string, any> = {}) =>
  row({ id: COURSE, tenantId: TENANT, title: 'Workplace Safety', status: TrainingCourseStatus.PUBLISHED, mandatoryByDefault: true, defaultDueDays: 14, ...over });

const assignment = (over: Record<string, any> = {}) =>
  row({
    id: ASSIGNMENT,
    tenantId: TENANT,
    courseId: COURSE,
    courseTitle: 'Workplace Safety',
    employeeId: ANNA,
    departmentId: DEPT,
    departmentName: 'Engineering',
    designationTitle: 'Developer',
    source: 'DIRECT',
    mandatory: true,
    dueDate: addDays(todayIso(), 10),
    status: 'NOT_STARTED',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    completionNote: null,
    assignedByEmail: 'hr@example.com',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    employee: { id: ANNA, firstName: 'Anna', lastName: 'Khan', employeeCode: 'EMP-1', avatarUrl: null },
    ...over,
  });

describe('LearningAssignmentService', () => {
  const today = todayIso();
  let courseModel: any;
  let employeeModel: any;
  let departmentModel: any;
  let designationModel: any;
  let assignmentModel: any;
  let materialModel: any;
  let progressModel: any;
  let recommendationModel: any;
  let auditModel: { create: jest.Mock };
  let sequelize: any;
  let dataScope: { visibleEmployeeIds: jest.Mock; employeeWhere: jest.Mock };
  let service: LearningAssignmentService;

  const created = () => assignmentModel.bulkCreate.mock.calls.flatMap((call: any[]) => call[0]) as any[];
  const last = () => created()[created().length - 1];

  beforeEach(() => {
    sequelize = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (work: (t: unknown) => unknown) => work('tx')),
    };
    courseModel = { findOne: jest.fn().mockResolvedValue(course()) };
    employeeModel = { findAll: jest.fn().mockResolvedValue([]) };
    departmentModel = { count: jest.fn().mockResolvedValue(1) };
    designationModel = { count: jest.fn().mockResolvedValue(1) };
    assignmentModel = {
      sequelize,
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      bulkCreate: jest.fn().mockResolvedValue([]),
    };
    materialModel = { findAll: jest.fn().mockResolvedValue([]) };
    progressModel = { sequelize, findAll: jest.fn().mockResolvedValue([]) };
    recommendationModel = { count: jest.fn().mockResolvedValue(0), update: jest.fn().mockResolvedValue([0]) };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    dataScope = { visibleEmployeeIds: jest.fn().mockResolvedValue(null), employeeWhere: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getTrainingCourseModel: jest.fn().mockResolvedValue(courseModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue(departmentModel),
      getDesignationModel: jest.fn().mockResolvedValue(designationModel),
      getTrainingAssignmentModel: jest.fn().mockResolvedValue(assignmentModel),
      getTrainingMaterialModel: jest.fn().mockResolvedValue(materialModel),
      getTrainingProgressModel: jest.fn().mockResolvedValue(progressModel),
      getTrainingRecommendationModel: jest.fn().mockResolvedValue(recommendationModel),
      getEntityAuditLogModel: jest.fn().mockResolvedValue(auditModel),
    };
    service = new LearningAssignmentService(provider, dataScope as any);
  });

  describe('assigning a course', () => {
    it('gives it to the employees named, with what was true about them at the time', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna'), person(BEN, 'Ben', { reportingManagerId: null, department: null, designation: null, departmentId: null })]);

      const result = await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA, BEN], dueDate: addDays(today, 7) });

      expect(result).toMatchObject({ courseId: COURSE, courseTitle: 'Workplace Safety', mandatory: true, dueDate: addDays(today, 7), created: 2, skipped: { alreadyAssigned: 0, notInScope: 0, inactive: 0 } });
      expect(created()).toHaveLength(2);
      expect(created()[0]).toMatchObject({
        tenantId: TENANT,
        courseId: COURSE,
        courseTitle: 'Workplace Safety',
        employeeId: ANNA,
        departmentId: DEPT,
        departmentName: 'Engineering',
        designationTitle: 'Developer',
        reportingManagerId: 'mgr-1',
        source: 'DIRECT',
        mandatory: true,
        dueDate: addDays(today, 7),
        status: 'NOT_STARTED',
        assignedByEmail: 'hr@example.com',
      });
      expect(created()[1]).toMatchObject({ employeeId: BEN, departmentName: null, designationTitle: null });
      expect(new Set(created().map((a) => a.batchId)).size).toBe(1);
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'training_assignments', recordId: result.batchId, action: 'CREATE' });
    });

    it('reaches everyone in a department or holding a designation, and says why', async () => {
      employeeModel.findAll.mockImplementation(async ({ where }: any) => {
        if (where.id) return [person(ANNA, 'Anna')];
        if (where.departmentId) return [person(ANNA, 'Anna'), person(BEN, 'Ben')];
        if (where.designationId) return [person(BEN, 'Ben'), person(CARA, 'Cara')];
        return [];
      });

      const result = await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], departmentIds: [DEPT], designationIds: [DESIGNATION] });

      expect(result.created).toBe(3);
      expect(Object.fromEntries(created().map((a) => [a.employeeId, a.source]))).toEqual({ [ANNA]: 'DIRECT', [BEN]: 'DEPARTMENT', [CARA]: 'DESIGNATION' });
    });

    it('asks only for people who still work here when it goes by department', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna')]);

      await service.assign(actor, { courseId: COURSE, departmentIds: [DEPT], dueInDays: 7 });

      const where = employeeModel.findAll.mock.calls[0][0].where;
      expect(where.departmentId[Op.in]).toEqual([DEPT]);
      expect(where.status[Op.in]).toEqual(['ACTIVE', 'ON_LEAVE']);
    });

    it('skips, and counts, people who left, who are outside the caller reach, or who already have it open', async () => {
      const [E4, E5] = ['e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4', 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'];
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna'), person(BEN, 'Ben', { status: 'RESIGNED' }), person(CARA, 'Cara'), person(E4, 'Dan'), person(E5, 'Eve')]);
      dataScope.visibleEmployeeIds.mockResolvedValue([ANNA, BEN, E4, E5]);
      assignmentModel.findAll.mockResolvedValue([{ employeeId: E4 }]);

      const result = await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA, BEN, CARA, E4, E5], dueInDays: 7 });

      expect(result.skipped).toEqual({ alreadyAssigned: 1, notInScope: 1, inactive: 1 });
      expect(created().map((a) => a.employeeId).sort()).toEqual([ANNA, E5].sort());
      expect(result.created).toBe(2);
    });

    it('creates nothing, and records nothing, when everyone is skipped', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna')]);
      assignmentModel.findAll.mockResolvedValue([{ employeeId: ANNA }]);

      const result = await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueInDays: 7 });

      expect(result).toMatchObject({ created: 0, skipped: { alreadyAssigned: 1 } });
      expect(assignmentModel.bulkCreate).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it('needs someone to assign to, a published course, and existing employees, departments and designations', async () => {
      await expect(service.assign(actor, { courseId: COURSE })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Choose who') });

      courseModel.findOne.mockResolvedValue(null);
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] })).rejects.toMatchObject({ status: 404 });

      courseModel.findOne.mockResolvedValue(course({ status: 'DRAFT' }));
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Publish') });
      courseModel.findOne.mockResolvedValue(course({ status: 'ARCHIVED' }));
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('archived') });

      courseModel.findOne.mockResolvedValue(course());
      employeeModel.findAll.mockResolvedValue([]);
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueInDays: 5 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('employee was not found') });

      departmentModel.count.mockResolvedValue(0);
      await expect(service.assign(actor, { courseId: COURSE, departmentIds: [DEPT], dueInDays: 5 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('department') });

      designationModel.count.mockResolvedValue(0);
      await expect(service.assign(actor, { courseId: COURSE, designationIds: [DESIGNATION], dueInDays: 5 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('designation') });
      expect(assignmentModel.bulkCreate).not.toHaveBeenCalled();
    });

    it('refuses an assignment that reaches too many people', async () => {
      employeeModel.findAll.mockResolvedValue(Array.from({ length: 2001 }, (_, index) => person(`id-${index}`, 'X')));

      await expect(service.assign(actor, { courseId: COURSE, departmentIds: [DEPT], dueInDays: 5 })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('2001'),
      });
    });

    it('says so when someone else assigned it at the same moment', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna')]);
      assignmentModel.bulkCreate.mockRejectedValue(new UniqueConstraintError({ errors: [] } as any));

      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueInDays: 5 })).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('the due date and whether it is mandatory', () => {
    beforeEach(() => employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna')]));

    it('uses a fixed date, N days from today, or the course\'s default, in that order', async () => {
      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueDate: addDays(today, 3) });
      expect(last().dueDate).toBe(addDays(today, 3));

      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueInDays: 5 });
      expect(last().dueDate).toBe(addDays(today, 5));

      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] });
      expect(last().dueDate).toBe(addDays(today, 14));
    });

    it('may have no due date when it is optional and the course has no default', async () => {
      courseModel.findOne.mockResolvedValue(course({ mandatoryByDefault: false, defaultDueDays: null }));

      const result = await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] });

      expect(result).toMatchObject({ mandatory: false, dueDate: null });
      expect(last()).toMatchObject({ mandatory: false, dueDate: null });
    });

    it('is mandatory when the course is, unless told otherwise, and a mandatory one needs a date', async () => {
      courseModel.findOne.mockResolvedValue(course({ mandatoryByDefault: true, defaultDueDays: null }));
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('due date') });

      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], mandatory: false });
      expect(last()).toMatchObject({ mandatory: false, dueDate: null });

      courseModel.findOne.mockResolvedValue(course({ mandatoryByDefault: false }));
      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], mandatory: true, dueInDays: 2 });
      expect(last()).toMatchObject({ mandatory: true, dueDate: addDays(today, 2) });
    });

    it('refuses a date in the past, or both a date and a number of days', async () => {
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueDate: addDays(today, -1) })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('past') });
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA], dueDate: addDays(today, 3), dueInDays: 3 })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not both') });
    });
  });

  describe('the list', () => {
    const scopeAndFilters = (call: number) => assignmentModel.findAndCountAll.mock.calls[call][0].where[Op.and];

    it('maps people, the department and designation they had when assigned, progress and the stored status as seen today', async () => {
      assignmentModel.findAndCountAll.mockResolvedValue({
        count: 3,
        rows: [
          assignment(),
          assignment({ id: 'b2', dueDate: addDays(today, -3), employeeId: BEN, employee: { id: BEN, firstName: 'Ben', lastName: 'Khan', employeeCode: 'EMP-2', avatarUrl: null } }),
          assignment({ id: 'b3', status: 'COMPLETED', completedAt: new Date(`${addDays(today, -1)}T10:00:00Z`), dueDate: addDays(today, -2) }),
        ],
      });
      sequelize.query
        .mockResolvedValueOnce([{ assignmentId: ASSIGNMENT, count: 1 }])
        .mockResolvedValueOnce([{ courseId: COURSE, count: 4 }]);

      const result = await service.getAssignments(TENANT, { page: 1, limit: 10 });

      expect(result.data[0]).toMatchObject({
        id: ASSIGNMENT,
        status: 'NOT_STARTED',
        progressStatus: 'NOT_STARTED',
        mandatory: true,
        employee: { employeeId: ANNA, name: 'Anna Khan', employeeCode: 'EMP-1' },
        department: 'Engineering',
        designation: 'Developer',
        assignedBy: 'hr@example.com',
        progress: { opened: 1, total: 4, percent: 25 },
      });
      expect(result.data[1]).toMatchObject({ status: 'OVERDUE', progressStatus: 'NOT_STARTED', overdueDays: 3 });
      expect(result.data[2]).toMatchObject({ status: 'COMPLETED', overdueDays: 0, completedLate: true });
    });

    it('stays inside what the caller can reach', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });

      await service.getAssignments(TENANT, {});

      expect(dataScope.employeeWhere).toHaveBeenCalledWith(TENANT, 'employeeId');
      expect(scopeAndFilters(0)[0]).toMatchObject({ tenantId: TENANT, employeeId: { [Op.in]: [ANNA] } });
    });

    it('filters by course, employee, department as it was and mandatory', async () => {
      await service.getAssignments(TENANT, { courseId: COURSE, employeeId: ANNA, departmentId: DEPT, mandatory: false });

      expect(scopeAndFilters(0)[0]).toMatchObject({ courseId: COURSE, employeeId: ANNA, departmentId: DEPT, mandatory: false });
    });

    it('reads overdue as open and past due, and leaves those out of not started and in progress', async () => {
      await service.getAssignments(TENANT, { status: 'OVERDUE' as any });
      expect(scopeAndFilters(0)[1]).toEqual({ status: { [Op.in]: ['NOT_STARTED', 'IN_PROGRESS'] }, dueDate: { [Op.lt]: today } });

      await service.getAssignments(TENANT, { status: 'IN_PROGRESS' as any });
      expect(scopeAndFilters(1)[1]).toMatchObject({ status: 'IN_PROGRESS' });
      expect(scopeAndFilters(1)[1][Op.and][0][Op.or]).toEqual([{ dueDate: null }, { dueDate: { [Op.gte]: today } }]);

      await service.getAssignments(TENANT, { status: 'COMPLETED' as any });
      expect(scopeAndFilters(2)[1]).toEqual({ status: 'COMPLETED' });

      await service.getAssignments(TENANT, { status: 'ALL' as any });
      expect(scopeAndFilters(3)[1]).toEqual({});
    });

    it('searches the course title and the employee\'s name or code', async () => {
      await service.getAssignments(TENANT, { search: 'safe%ty' });

      const search = scopeAndFilters(0)[2][Op.or];
      expect(search.map((clause: any) => Object.keys(clause)[0])).toEqual(['courseTitle', '$employee.firstName$', '$employee.lastName$', '$employee.employeeCode$']);
      expect(search[0].courseTitle[Op.iLike]).toBe('%safe\\%ty%');
    });

    it('counts each status for the same people, and pages', async () => {
      assignmentModel.count.mockImplementation(async ({ where }: any) => {
        const status = where[Op.and][1];
        return status.dueDate ? 2 : status.status === 'COMPLETED' ? 7 : status.status === 'IN_PROGRESS' ? 4 : 5;
      });
      assignmentModel.findAndCountAll.mockResolvedValue({ rows: [], count: 21 });

      const result = await service.getAssignments(TENANT, { page: 2, limit: 10 });

      expect(assignmentModel.findAndCountAll.mock.calls[0][0]).toMatchObject({ limit: 10, offset: 10 });
      expect(result).toMatchObject({ total: 21, totalPages: 3, summary: { notStarted: 5, inProgress: 4, completed: 7, overdue: 2 } });
    });

    it('sorts by due date with those without one last, or by name', async () => {
      await service.getAssignments(TENANT, { sortBy: 'dueDate', sortOrder: 'asc' });
      const order = assignmentModel.findAndCountAll.mock.calls[0][0].order;
      expect(String(order[0][0].val)).toBe('"TrainingAssignment"."dueDate" ASC NULLS LAST');

      await service.getAssignments(TENANT, { sortBy: 'courseTitle', sortOrder: 'asc' });
      expect(assignmentModel.findAndCountAll.mock.calls[1][0].order[0]).toEqual(['courseTitle', 'ASC']);
    });
  });

  describe('one assignment', () => {
    it('shows which materials the person has opened', async () => {
      assignmentModel.findOne.mockResolvedValue(assignment());
      materialModel.findAll.mockResolvedValue([
        { id: 'm1', kind: 'FILE', title: 'Handbook', required: true },
        { id: 'm2', kind: 'LINK', title: 'Site', required: false },
      ]);
      progressModel.findAll.mockResolvedValue([{ materialId: 'm1', openedAt: new Date('2026-11-02T09:00:00Z') }]);

      const result = await service.getAssignment(TENANT, ASSIGNMENT);

      expect(result.progress).toEqual({ opened: 1, total: 2, percent: 50 });
      expect(result.materials).toEqual([
        expect.objectContaining({ id: 'm1', opened: true, required: true }),
        expect.objectContaining({ id: 'm2', opened: false, openedAt: null, required: false }),
      ]);
    });

    it('is not found when it belongs to someone the caller cannot reach', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [] } });

      await expect(service.getAssignment(TENANT, ASSIGNMENT)).rejects.toMatchObject({ status: 404 });
      expect(assignmentModel.findOne.mock.calls[0][0].where[Op.and][1]).toEqual({ employeeId: { [Op.in]: [] } });
    });
  });

  describe('changing an assignment', () => {
    const arrange = (over: Record<string, any> = {}) => {
      const a = assignment(over);
      assignmentModel.findOne.mockResolvedValue(a);
      return a;
    };

    it('moves the due date and records what changed', async () => {
      const a = arrange();

      await service.updateAssignment(actor, ASSIGNMENT, { dueDate: addDays(today, 30) });

      // A new date means the reminders are due afresh.
      expect(a.update).toHaveBeenCalledWith({ dueDate: addDays(today, 30), mandatory: true, remindersSent: [], overdueNoticeSent: false });
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({
        tableName: 'training_assignments',
        action: 'UPDATE',
        changes: expect.objectContaining({ dueDate: { from: addDays(today, 10), to: addDays(today, 30) } }),
      });
    });

    it('does nothing when nothing changed', async () => {
      const a = arrange();

      await service.updateAssignment(actor, ASSIGNMENT, { mandatory: true });

      expect(a.update).not.toHaveBeenCalled();
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it('keeps a mandatory assignment dated, and will not move a date into the past', async () => {
      arrange();
      await expect(service.updateAssignment(actor, ASSIGNMENT, { dueDate: null })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('due date') });
      await expect(service.updateAssignment(actor, ASSIGNMENT, { dueDate: addDays(today, -2) })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('past') });

      const a = arrange();
      await service.updateAssignment(actor, ASSIGNMENT, { mandatory: false, dueDate: null });
      expect(a.update).toHaveBeenCalledWith({ dueDate: null, mandatory: false, remindersSent: [], overdueNoticeSent: false });
    });

    it('keeps the reminder stamps when only the mandatory flag changes', async () => {
      const a = arrange({ mandatory: false });
      await service.updateAssignment(actor, ASSIGNMENT, { mandatory: true });
      expect(a.update).toHaveBeenCalledWith({ dueDate: addDays(today, 10), mandatory: true });
    });

    it('leaves a finished or cancelled assignment alone', async () => {
      arrange({ status: 'COMPLETED' });
      await expect(service.updateAssignment(actor, ASSIGNMENT, { dueDate: addDays(today, 5) })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stays on record') });
      await expect(service.cancelAssignment(actor, ASSIGNMENT, {})).rejects.toMatchObject({ status: 409 });

      arrange({ status: 'CANCELLED' });
      await expect(service.cancelAssignment(actor, ASSIGNMENT, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('cancelled') });
    });

    it('cancels a course that has not been finished, with the reason', async () => {
      const a = arrange({ status: 'IN_PROGRESS' });

      await service.cancelAssignment(actor, ASSIGNMENT, { reason: 'Role changed' });

      const patch = a.update.mock.calls[0][0];
      expect(patch).toMatchObject({ status: 'CANCELLED', cancelReason: 'Role changed' });
      expect(patch.cancelledAt).toBeInstanceOf(Date);
      expect(auditModel.create.mock.calls[0][0].changes).toMatchObject({ status: { from: 'IN_PROGRESS', to: 'CANCELLED' } });
    });
  });

  describe('the export', () => {
    it('uses the same filters as the list, within the caller\'s scope, and ignores the page', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });
      assignmentModel.findAndCountAll.mockResolvedValue({ rows: [assignment()], count: 1 });

      const result = await service.exportAssignments(TENANT, { courseId: COURSE, status: 'OVERDUE', search: 'anna', page: 3, limit: 5 } as any);

      const options = assignmentModel.findAndCountAll.mock.calls[0][0];
      expect(options.limit).toBe(10000);
      expect(options.offset).toBeUndefined();
      const and = options.where[Op.and];
      expect(and[0]).toMatchObject({ tenantId: TENANT, courseId: COURSE, employeeId: { [Op.in]: [ANNA] } });
      expect(and[1]).toMatchObject({ dueDate: { [Op.lt]: today } });
      expect(and[2][Op.or]).toHaveLength(4);
      expect(result).toMatchObject({ totalMatched: 1, truncated: false, limit: 10000 });
      expect(result.rows[0]).toMatchObject({ courseTitle: 'Workplace Safety', employee: { name: 'Anna Khan', employeeCode: 'EMP-1' }, department: 'Engineering' });
    });

    it('says so when the cap cut it short', async () => {
      assignmentModel.findAndCountAll.mockResolvedValue({ rows: [assignment()], count: 12000 });
      expect(await service.exportAssignments(TENANT, {})).toMatchObject({ totalMatched: 12000, truncated: true });
    });
  });

  describe('notifications and the bell', () => {
    let notifier: { assigned: jest.Mock; changed: jest.Mock; cancelled: jest.Mock };

    beforeEach(() => {
      notifier = { assigned: jest.fn(), changed: jest.fn(), cancelled: jest.fn() };
      service = new LearningAssignmentService((service as any).modelProvider, dataScope as any, notifier as any);
    });

    it('tells everyone who was given the course, and nobody who was skipped', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna'), person(BEN, 'Ben', { status: 'RESIGNED' })]);

      await service.assign(actor, { courseId: COURSE, employeeIds: [ANNA, BEN], dueDate: addDays(today, 5), mandatory: true } as any);

      expect(notifier.assigned).toHaveBeenCalledTimes(1);
      expect(notifier.assigned).toHaveBeenCalledWith(TENANT, [{ employeeId: ANNA, courseTitle: expect.any(String), mandatory: true, dueDate: addDays(today, 5) }]);
    });

    it('sends nothing when nobody was assigned', async () => {
      employeeModel.findAll.mockResolvedValue([person(ANNA, 'Anna', { status: 'RESIGNED' })]);
      await expect(service.assign(actor, { courseId: COURSE, employeeIds: [ANNA] } as any)).resolves.toMatchObject({ created: 0 });
      expect(notifier.assigned).not.toHaveBeenCalled();
    });

    it('tells the person when the due date or the mandatory flag changed', async () => {
      const a = assignment();
      assignmentModel.findOne.mockResolvedValue(a);
      await service.updateAssignment(actor, ASSIGNMENT, { dueDate: addDays(today, 30) });
      expect(notifier.changed).toHaveBeenCalledWith(
        TENANT,
        expect.objectContaining({ employeeId: a.employeeId, mandatory: true, dueDate: addDays(today, 30) }),
        { dueDate: true, mandatory: false },
      );
    });

    it('stays quiet when nothing changed', async () => {
      assignmentModel.findOne.mockResolvedValue(assignment());
      await service.updateAssignment(actor, ASSIGNMENT, { mandatory: true });
      expect(notifier.changed).not.toHaveBeenCalled();
    });

    it('tells the person when a course is withdrawn', async () => {
      const a = assignment({ status: 'IN_PROGRESS' });
      assignmentModel.findOne.mockResolvedValue(a);
      await service.cancelAssignment(actor, ASSIGNMENT, { reason: 'Role changed' });
      expect(notifier.cancelled).toHaveBeenCalledWith(TENANT, { employeeId: a.employeeId, courseTitle: a.courseTitle }, 'Role changed');
    });

    it('counts what needs attention among the people the caller can reach', async () => {
      assignmentModel.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
      recommendationModel.count.mockResolvedValue(5);
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });

      const alerts = await service.getAlerts(TENANT);

      expect(alerts).toEqual({ overdue: 4, mandatoryOverdue: 2, dueSoon: 3, dueSoonDays: 3, pendingRecommendations: 5, total: 12 });
      expect(recommendationModel.count.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, status: 'PENDING', employeeId: { [Op.in]: [ANNA] } });
      const overdueWhere = assignmentModel.count.mock.calls[0][0].where;
      expect(overdueWhere).toMatchObject({ tenantId: TENANT, employeeId: { [Op.in]: [ANNA] }, dueDate: { [Op.lt]: today } });
      expect(assignmentModel.count.mock.calls[1][0].where).toMatchObject({ mandatory: true });
      expect(assignmentModel.count.mock.calls[2][0].where.dueDate).toEqual({ [Op.gte]: today, [Op.lte]: addDays(today, 3) });
    });
  });

  describe('a person\'s learning record', () => {
    beforeEach(() => {
      (dataScope as any).assertCanSee = jest.fn().mockResolvedValue(undefined);
      employeeModel.findOne = jest.fn().mockResolvedValue({ id: ANNA, firstName: 'Anna', lastName: 'Khan', employeeCode: 'EMP-1', avatarUrl: null });
    });

    it('shows everything the person has had, with a count for each state', async () => {
      assignmentModel.findAndCountAll.mockResolvedValue({ rows: [assignment()], count: 1 });
      assignmentModel.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(5).mockResolvedValueOnce(1).mockResolvedValueOnce(3);

      const result = await service.getForEmployee(TENANT, ANNA, {});

      expect(result.employee).toMatchObject({ employeeId: ANNA, name: 'Anna Khan', employeeCode: 'EMP-1' });
      expect(result.data).toHaveLength(1);
      expect(result.summary).toEqual({ notStarted: 1, inProgress: 2, completed: 5, overdue: 1, cancelled: 3 });
      expect(assignmentModel.findAndCountAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, employeeId: ANNA });
    });

    it('is not shown for someone the caller cannot reach', async () => {
      (dataScope as any).assertCanSee.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
      await expect(service.getForEmployee(TENANT, ANNA, {})).rejects.toMatchObject({ status: 404 });
      expect(assignmentModel.findAndCountAll).not.toHaveBeenCalled();
    });

    it('404s for an employee that does not exist', async () => {
      employeeModel.findOne.mockResolvedValue(null);
      await expect(service.getForEmployee(TENANT, ANNA, {})).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('onboarding courses', () => {
    let notifier: { assigned: jest.Mock };

    beforeEach(() => {
      notifier = { assigned: jest.fn() };
      service = new LearningAssignmentService((service as any).modelProvider, dataScope as any, notifier as any);
      employeeModel.findOne = jest.fn().mockResolvedValue(person(ANNA, 'Anna', { department: { name: 'Engineering' }, designation: { title: 'Developer' } }));
      courseModel.findAll = jest.fn().mockResolvedValue([
        course({ id: 'c-1', title: 'Safety', mandatoryByDefault: true, defaultDueDays: 7 }),
        course({ id: 'c-2', title: 'Code of Conduct', mandatoryByDefault: true, defaultDueDays: null }),
        course({ id: 'c-3', title: 'Culture', mandatoryByDefault: false, defaultDueDays: null }),
      ]);
    });

    it('gives a new joiner every course marked for joining, dated from today', async () => {
      expect(await service.autoAssignOnJoin(TENANT, ANNA)).toBe(3);

      const rows = created();
      expect(rows.map((r) => r.courseTitle)).toEqual(['Safety', 'Code of Conduct', 'Culture']);
      expect(rows.every((r) => r.source === 'ONBOARDING' && r.employeeId === ANNA && r.status === 'NOT_STARTED')).toBe(true);
      expect(rows[0]).toMatchObject({ mandatory: true, dueDate: addDays(today, 7), departmentName: 'Engineering', designationTitle: 'Developer' });
      // A mandatory course must have a date: 30 days when the course has no default.
      expect(rows[1]).toMatchObject({ mandatory: true, dueDate: addDays(today, 30) });
      expect(rows[2]).toMatchObject({ mandatory: false, dueDate: null });
      expect(courseModel.findAll.mock.calls[0][0].where).toMatchObject({ status: 'PUBLISHED', autoAssignOnJoin: true });
      expect(notifier.assigned).toHaveBeenCalledWith(TENANT, expect.arrayContaining([expect.objectContaining({ employeeId: ANNA, courseTitle: 'Safety' })]));
      expect(auditModel.create).toHaveBeenCalled();
    });

    it('skips a course the person already has open', async () => {
      assignmentModel.findAll.mockResolvedValue([{ courseId: 'c-1' }]);
      expect(await service.autoAssignOnJoin(TENANT, ANNA)).toBe(2);
      expect(created().map((r) => r.courseTitle)).toEqual(['Code of Conduct', 'Culture']);
    });

    it('does nothing when no course is marked, or the person is not employed', async () => {
      courseModel.findAll.mockResolvedValue([]);
      expect(await service.autoAssignOnJoin(TENANT, ANNA)).toBe(0);

      courseModel.findAll.mockResolvedValue([course({ id: 'c-1' })]);
      employeeModel.findOne.mockResolvedValue(person(ANNA, 'Anna', { status: 'RESIGNED' }));
      expect(await service.autoAssignOnJoin(TENANT, ANNA)).toBe(0);
      expect(assignmentModel.bulkCreate).not.toHaveBeenCalled();
    });

    it('never throws: the employee already exists', async () => {
      assignmentModel.bulkCreate.mockRejectedValue(new Error('db down'));
      await expect(service.autoAssignOnJoin(TENANT, ANNA)).resolves.toBe(0);
    });
  });

  describe('when someone leaves', () => {
    it('withdraws what they had not finished and leaves what they completed', async () => {
      assignmentModel.findAll.mockResolvedValue([{ id: 'a-1' }, { id: 'a-2' }]);
      assignmentModel.update = jest.fn().mockResolvedValue([2]);

      expect(await service.cancelOpenForExit(TENANT, ANNA)).toBe(2);

      expect(assignmentModel.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, employeeId: ANNA, status: { [Op.in]: ['NOT_STARTED', 'IN_PROGRESS'] } });
      const [values, options] = assignmentModel.update.mock.calls[0];
      expect(values).toMatchObject({ status: 'CANCELLED', cancelReason: 'Employee left the organization' });
      expect(values.cancelledAt).toBeInstanceOf(Date);
      expect(options.where.id).toEqual({ [Op.in]: ['a-1', 'a-2'] });
      expect(auditModel.create).toHaveBeenCalled();
    });

    it('closes suggestions still waiting for a decision about them', async () => {
      await service.cancelOpenForExit(TENANT, ANNA);
      expect(recommendationModel.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'DISMISSED', dismissReason: 'Employee left the organization' }),
        { where: { tenantId: TENANT, employeeId: ANNA, status: 'PENDING' } },
      );
    });

    it('does nothing when they had nothing open', async () => {
      assignmentModel.update = jest.fn();
      expect(await service.cancelOpenForExit(TENANT, ANNA)).toBe(0);
      expect(assignmentModel.update).not.toHaveBeenCalled();
    });
  });

  describe('training records', () => {
    it('counts what these people have, whatever its state, suggestions included', async () => {
      assignmentModel.count.mockResolvedValue(3);
      recommendationModel.count.mockResolvedValue(2);

      await expect(service.countFor(TENANT, [ANNA, BEN])).resolves.toBe(5);
      expect(assignmentModel.count.mock.calls[0][0].where.employeeId[Op.in]).toEqual([ANNA, BEN]);
      assignmentModel.count.mockClear();
      await expect(service.countFor(TENANT, [])).resolves.toBe(0);
      expect(assignmentModel.count).not.toHaveBeenCalled();
    });
  });
});
