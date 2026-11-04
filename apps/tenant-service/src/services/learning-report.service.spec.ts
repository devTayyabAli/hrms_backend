import { Op } from 'sequelize';
import { LearningReportGroup } from '@app/common';
import { LearningReportService } from './learning-report.service';
import { todayIso } from './workspace-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const DEPT = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';

describe('LearningReportService', () => {
  const today = todayIso();
  let courseModel: any;
  let assignmentModel: any;
  let recommendationModel: any;
  let dataScope: { employeeWhere: jest.Mock };
  let service: LearningReportService;

  beforeEach(() => {
    courseModel = { count: jest.fn(async ({ where }: any) => ({ PUBLISHED: 6, DRAFT: 2, ARCHIVED: 1 })[where.status as string]) };
    assignmentModel = {
      sequelize: { escape: (value: string) => `'${value}'` },
      count: jest.fn().mockResolvedValue(0),
      findAll: jest.fn().mockResolvedValue([]),
    };
    recommendationModel = { count: jest.fn().mockResolvedValue(3) };
    dataScope = { employeeWhere: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getTrainingCourseModel: async () => courseModel,
      getTrainingAssignmentModel: async () => assignmentModel,
      getTrainingRecommendationModel: async () => recommendationModel,
    };
    service = new LearningReportService(provider, dataScope as any);
  });

  describe('the dashboard', () => {
    it('counts courses, assignments by state, and works out the rates', async () => {
      // Promise.all starts the counts in order: assigned, completed, notStarted, inProgress, overdue,
      // mandatoryTotal, mandatoryCompleted, mandatoryOverdue, completedThisMonth.
      const counts = [40, 20, 8, 6, 4, 10, 7, 2, 5];
      assignmentModel.count.mockImplementation(async () => counts.shift());
      assignmentModel.findAll.mockResolvedValue([
        { groupId: 'c-1', groupName: 'Safety', assigned: '12', completed: '9', notStarted: '1', inProgress: '1', overdue: '1', completedLate: '2', avgDays: '3.26' },
      ]);

      const result = await service.getDashboard(TENANT);

      expect(result.courses).toEqual({ published: 6, draft: 2, archived: 1 });
      expect(result.assignments).toEqual({ total: 40, completed: 20, notStarted: 8, inProgress: 6, overdue: 4, completedThisMonth: 5 });
      expect(result.completionRate).toBe(50);
      expect(result.mandatory).toEqual({ total: 10, completed: 7, overdue: 2, complianceRate: 70 });
      expect(result.pendingRecommendations).toBe(3);
      expect(result.topCourses).toEqual([
        { courseId: 'c-1', name: 'Safety', assigned: 12, notStarted: 1, inProgress: 1, completed: 9, overdue: 1, completedLate: 2, completionRate: 75, avgDaysToComplete: 3.3 },
      ]);
      expect(assignmentModel.findAll.mock.calls[0][0].limit).toBe(5);
    });

    it('has no rates when there is nothing to divide by', async () => {
      const result = await service.getDashboard(TENANT);
      expect(result.completionRate).toBeNull();
      expect(result.mandatory.complianceRate).toBeNull();
      expect(result.topCourses).toEqual([]);
    });

    it('counts only the people the caller can reach, and leaves cancelled assignments out of the total', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });

      await service.getDashboard(TENANT);

      const wheres = assignmentModel.count.mock.calls.map((call: any[]) => call[0].where);
      expect(wheres.every((where: any) => where.tenantId === TENANT && where.employeeId[Op.in][0] === ANNA)).toBe(true);
      expect(wheres[0].status).toEqual({ [Op.ne]: 'CANCELLED' });
      expect(recommendationModel.count.mock.calls[0][0].where).toMatchObject({ status: 'PENDING', employeeId: { [Op.in]: [ANNA] } });
    });
  });

  describe('the reports', () => {
    it('groups by course with the date range and department, scope and cancelled left out', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });

      const result = await service.getReport(TENANT, LearningReportGroup.COURSE, { from: '2026-01-01', to: '2026-12-31', departmentId: DEPT });

      expect(result).toEqual({ group: 'COURSE', rows: [] });
      const options = assignmentModel.findAll.mock.calls[0][0];
      expect(options.group).toEqual(['courseId']);
      expect(options.raw).toBe(true);
      expect(options.limit).toBe(200);
      expect(options.where).toMatchObject({ tenantId: TENANT, status: { [Op.ne]: 'CANCELLED' }, employeeId: { [Op.in]: [ANNA] }, departmentId: DEPT });
      expect(options.where.createdAt[Op.gte]).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      // The last day is included.
      expect(options.where.createdAt[Op.lt]).toEqual(new Date('2027-01-01T00:00:00.000Z'));
    });

    it('groups by department as it was when assigned, and names the people with none', async () => {
      assignmentModel.findAll.mockResolvedValue([
        { groupId: DEPT, groupName: 'Engineering', assigned: '4', completed: '0', notStarted: '4', inProgress: '0', overdue: '0', completedLate: '0', avgDays: null },
        { groupId: null, groupName: null, assigned: '1', completed: '1', notStarted: '0', inProgress: '0', overdue: '0', completedLate: '0', avgDays: '1' },
      ]);

      const { rows } = await service.getReport(TENANT, LearningReportGroup.DEPARTMENT, { departmentId: DEPT });

      const options = assignmentModel.findAll.mock.calls[0][0];
      expect(options.group).toEqual(['departmentId']);
      // The department filter belongs to the course report only.
      expect(options.where.departmentId).toBeUndefined();
      expect(rows[0]).toMatchObject({ departmentId: DEPT, name: 'Engineering', assigned: 4, completionRate: 0, avgDaysToComplete: null });
      expect(rows[1]).toMatchObject({ departmentId: null, name: 'No department', completionRate: 100, avgDaysToComplete: 1 });
    });

    it('works out overdue and late with the date of the day it runs', async () => {
      await service.getReport(TENANT, LearningReportGroup.COURSE, {});
      const attributes = assignmentModel.findAll.mock.calls[0][0].attributes.map((attribute: any) => (Array.isArray(attribute) ? attribute[0]?.val ?? '' : ''));
      expect(attributes.join(' ')).toContain(`"dueDate" < '${today}'`);
    });
  });
});
