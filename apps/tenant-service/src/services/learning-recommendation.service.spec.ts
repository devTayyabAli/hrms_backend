import { Op, UniqueConstraintError } from 'sequelize';
import { LearningRecommendationService } from './learning-recommendation.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COURSE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const REVIEW = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const REC = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const actor = { tenantId: TENANT, userId: 'user-1', email: 'hr@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const recommendation = (over: Record<string, any> = {}) =>
  row({
    id: REC,
    tenantId: TENANT,
    employeeId: ANNA,
    courseId: COURSE,
    courseTitle: 'Communication Skills',
    reviewId: REVIEW,
    reviewCycle: '2026 Q3',
    reason: 'Communication scored 2.5',
    status: 'PENDING',
    recommendedByEmail: 'lead@example.com',
    createdAt: new Date('2026-11-01T00:00:00Z'),
    employee: { id: ANNA, firstName: 'Anna', lastName: 'Khan', employeeCode: 'EMP-1', avatarUrl: null },
    ...over,
  });

describe('LearningRecommendationService', () => {
  let employeeModel: any;
  let courseModel: any;
  let reviewModel: any;
  let assignmentModel: any;
  let recommendationModel: any;
  let auditModel: { create: jest.Mock };
  let assignments: { assign: jest.Mock };
  let dataScope: { assertCanSee: jest.Mock; employeeWhere: jest.Mock };
  let service: LearningRecommendationService;

  beforeEach(() => {
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: ANNA, status: 'ACTIVE' }) };
    courseModel = { findOne: jest.fn().mockResolvedValue({ id: COURSE, title: 'Communication Skills', status: 'PUBLISHED' }) };
    reviewModel = { findOne: jest.fn().mockResolvedValue({ id: REVIEW, employeeId: ANNA, cycle: '2026 Q3' }) };
    assignmentModel = { count: jest.fn().mockResolvedValue(0), findOne: jest.fn().mockResolvedValue({ id: 'asg-1' }) };
    recommendationModel = {
      create: jest.fn().mockResolvedValue({ id: REC }),
      findOne: jest.fn().mockResolvedValue(recommendation()),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [recommendation()], count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    assignments = { assign: jest.fn().mockResolvedValue({ batchId: 'batch-1', created: 1 }) };
    dataScope = { assertCanSee: jest.fn().mockResolvedValue(undefined), employeeWhere: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getTrainingCourseModel: jest.fn().mockResolvedValue(courseModel),
      getPerformanceReviewModel: jest.fn().mockResolvedValue(reviewModel),
      getTrainingAssignmentModel: jest.fn().mockResolvedValue(assignmentModel),
      getTrainingRecommendationModel: jest.fn().mockResolvedValue(recommendationModel),
      getEntityAuditLogModel: jest.fn().mockResolvedValue(auditModel),
    };
    service = new LearningRecommendationService(provider, assignments as any, dataScope as any);
  });

  describe('recommending', () => {
    const dto = { employeeId: ANNA, courseId: COURSE, reviewId: REVIEW, reason: 'Communication scored 2.5' };

    it('saves a pending suggestion with the course and review as they are now, and records it', async () => {
      const result = await service.recommend(actor, dto);

      expect(recommendationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          employeeId: ANNA,
          courseId: COURSE,
          courseTitle: 'Communication Skills',
          reviewId: REVIEW,
          reviewCycle: '2026 Q3',
          status: 'PENDING',
          recommendedByEmail: 'hr@example.com',
        }),
      );
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'training_recommendations', action: 'CREATE' });
      expect(result).toMatchObject({ id: REC, status: 'PENDING', courseTitle: 'Communication Skills', employee: { name: 'Anna Khan' } });
    });

    it('works without a review', async () => {
      await service.recommend(actor, { employeeId: ANNA, courseId: COURSE, reason: 'Growth' });
      expect(reviewModel.findOne).not.toHaveBeenCalled();
      expect(recommendationModel.create.mock.calls[0][0]).toMatchObject({ reviewId: null, reviewCycle: null });
    });

    it('is refused for someone the caller cannot reach', async () => {
      dataScope.assertCanSee.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 404 });
      expect(recommendationModel.create).not.toHaveBeenCalled();
    });

    it('is refused for a review that is someone else\'s, or a course that is not published', async () => {
      reviewModel.findOne.mockResolvedValue({ id: REVIEW, employeeId: 'other', cycle: 'x' });
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 400 });

      courseModel.findOne.mockResolvedValue({ id: COURSE, title: 'Old', status: 'ARCHIVED' });
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('published') });
      courseModel.findOne.mockResolvedValue(null);
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 404 });
    });

    it('is refused when the person has left, already has the course, or it is already waiting', async () => {
      employeeModel.findOne.mockResolvedValue({ id: ANNA, status: 'RESIGNED' });
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 409 });

      employeeModel.findOne.mockResolvedValue({ id: ANNA, status: 'ACTIVE' });
      assignmentModel.count.mockResolvedValue(1);
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already has') });

      assignmentModel.count.mockResolvedValue(0);
      recommendationModel.create.mockRejectedValue(new UniqueConstraintError({} as any));
      await expect(service.recommend(actor, dto)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('waiting') });
    });
  });

  describe('the list', () => {
    it('shows pending by default, for the people the caller can reach, with counts', async () => {
      dataScope.employeeWhere.mockResolvedValue({ employeeId: { [Op.in]: [ANNA] } });
      recommendationModel.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2).mockResolvedValueOnce(1);

      const result = await service.getRecommendations(TENANT, {});

      expect(recommendationModel.findAndCountAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, employeeId: { [Op.in]: [ANNA] }, status: 'PENDING' });
      expect(result).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1, summary: { pending: 4, assigned: 2, dismissed: 1 } });
      expect(result.data[0]).toMatchObject({ id: REC, reviewCycle: '2026 Q3', recommendedBy: 'lead@example.com' });
    });

    it('can show everything, or one person or course', async () => {
      await service.getRecommendations(TENANT, { status: 'ALL' as any, employeeId: ANNA, courseId: COURSE });
      expect(recommendationModel.findAndCountAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, employeeId: ANNA, courseId: COURSE });
    });
  });

  describe('deciding', () => {
    it('assigns the course as an ordinary assignment and links it', async () => {
      const result = await service.approve(actor, REC, { dueInDays: 14, mandatory: true });

      expect(assignments.assign).toHaveBeenCalledWith(actor, expect.objectContaining({ courseId: COURSE, employeeIds: [ANNA], dueInDays: 14, mandatory: true }));
      expect(assignmentModel.findOne.mock.calls[0][0].where).toMatchObject({ batchId: 'batch-1', employeeId: ANNA });
      expect(result).toMatchObject({ status: 'ASSIGNED', assignmentId: 'asg-1', decidedBy: 'hr@example.com' });
      expect(auditModel.create.mock.calls[0][0].changes).toMatchObject({ status: { from: 'PENDING', to: 'ASSIGNED' } });
    });

    it('stays pending when nothing was assigned', async () => {
      assignments.assign.mockResolvedValue({ batchId: 'b', created: 0 });
      const rec = recommendation();
      recommendationModel.findOne.mockResolvedValue(rec);
      await expect(service.approve(actor, REC, {})).rejects.toMatchObject({ status: 409 });
      expect(rec.update).not.toHaveBeenCalled();
    });

    it('stays pending when the assignment itself is refused', async () => {
      assignments.assign.mockRejectedValue(Object.assign(new Error('A mandatory course needs a due date.'), { status: 400 }));
      const rec = recommendation();
      recommendationModel.findOne.mockResolvedValue(rec);
      await expect(service.approve(actor, REC, {})).rejects.toMatchObject({ status: 400 });
      expect(rec.update).not.toHaveBeenCalled();
    });

    it('dismisses with a reason', async () => {
      const result = await service.dismiss(actor, REC, { reason: 'Covered in onboarding' });
      expect(result).toMatchObject({ status: 'DISMISSED', dismissReason: 'Covered in onboarding', decidedBy: 'hr@example.com' });
      expect(assignments.assign).not.toHaveBeenCalled();
    });

    it('cannot decide the same one twice, or one the caller cannot reach', async () => {
      recommendationModel.findOne.mockResolvedValue(recommendation({ status: 'ASSIGNED' }));
      await expect(service.approve(actor, REC, {})).rejects.toMatchObject({ status: 409 });
      await expect(service.dismiss(actor, REC, {})).rejects.toMatchObject({ status: 409 });

      recommendationModel.findOne.mockResolvedValue(null);
      await expect(service.approve(actor, REC, {})).rejects.toMatchObject({ status: 404 });
    });
  });
});
