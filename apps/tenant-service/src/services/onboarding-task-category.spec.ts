import { OnboardingTaskCategory } from '@app/common';
import { OnboardingTaskService } from './onboarding-task.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TASK = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

describe('OnboardingTaskService.setStatus restricted to one category', () => {
  let taskModel: any;
  let record: any;
  let service: OnboardingTaskService;

  beforeEach(() => {
    record = {
      id: TASK,
      title: 'Create email and system accounts',
      category: OnboardingTaskCategory.IT_SETUP,
      status: 'PENDING',
      sortOrder: 40,
      update: jest.fn(async (patch: any) => Object.assign(record, patch)),
    };
    taskModel = { findOne: jest.fn().mockResolvedValue(record) };
    const provider: any = {
      getOnboardingTaskModel: async () => taskModel,
      getNewHireModel: async () => ({}),
      getEmployeeModel: async () => ({}),
    };
    service = new OnboardingTaskService(provider);
  });

  it('looks for the task inside that category only, so any other task is not found', async () => {
    taskModel.findOne.mockResolvedValueOnce(null);

    await expect(service.setStatus(TENANT, TASK, { completed: true } as any, 'user-1', OnboardingTaskCategory.IT_SETUP)).rejects.toMatchObject({ status: 404 });

    expect(taskModel.findOne.mock.calls[0][0].where).toEqual({ id: TASK, tenantId: TENANT, category: OnboardingTaskCategory.IT_SETUP });
  });

  it('is not restricted when no category is given', async () => {
    jest.spyOn(service, 'getOne').mockResolvedValue({} as any);

    await service.setStatus(TENANT, TASK, { completed: true } as any, 'user-1');

    expect(taskModel.findOne.mock.calls[0][0].where).toEqual({ id: TASK, tenantId: TENANT });
    expect(record.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'COMPLETED', completedByUserId: 'user-1' }));
  });
});
