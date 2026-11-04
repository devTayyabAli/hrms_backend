import { LearningNotificationService, learningNoticePrefs } from './learning-notification.service';

const TENANT = 'tenant-1';

interface Options {
  setting?: Record<string, unknown> | null;
  open?: any[];
  people?: any[];
  failWrite?: boolean;
}

const build = (options: Options = {}) => {
  const created: any[] = [];
  const settingRow: any = options.setting ? { ...options.setting, update: jest.fn(async (values: any) => Object.assign(settingRow, values)) } : null;
  const Setting: any = {
    findOne: jest.fn(async () => settingRow),
    create: jest.fn(async (values: any) => values),
  };
  const Notification: any = {
    bulkCreate: jest.fn(async (rows: any[]) => {
      if (options.failWrite) throw new Error('db down');
      created.push(...rows);
      return rows;
    }),
  };
  const Assignment: any = { findAll: jest.fn(async () => options.open ?? []) };
  const Employee: any = {
    findAll: jest.fn(async () => options.people ?? []),
    findOne: jest.fn(async ({ where }: any) => (options.people ?? []).find((person) => person.id === where.id) ?? null),
  };
  const Audit: any = { create: jest.fn(async () => ({})) };
  const provider: any = {
    getLearningSettingModel: async () => Setting,
    getEmployeeNotificationModel: async () => Notification,
    getTrainingAssignmentModel: async () => Assignment,
    getEmployeeModel: async () => Employee,
    getEntityAuditLogModel: async () => Audit,
  };
  return { service: new LearningNotificationService(provider), created, Setting, settingRow, Notification, Assignment };
};

const assignment = (extra: Record<string, unknown> = {}) => {
  const row: any = {
    id: 'a-1',
    employeeId: 'e-1',
    courseTitle: 'Safety',
    mandatory: true,
    dueDate: '2026-11-10',
    remindersSent: [],
    overdueNoticeSent: false,
    reportingManagerId: 'm-1',
    ...extra,
  };
  row.update = jest.fn(async (values: any) => Object.assign(row, values));
  return row;
};

const person = (id = 'e-1', managerId: string | null = 'm-1') => ({ id, firstName: 'Ayesha', lastName: 'Khan', reportingManagerId: managerId });

describe('learningNoticePrefs', () => {
  it('is all on, with reminders 3 and 1 days before, when nothing was saved', async () => {
    const { service } = build();
    expect(await service.getSettings(TENANT)).toEqual({
      assignmentNotificationsEnabled: true,
      deadlineRemindersEnabled: true,
      overdueRemindersEnabled: true,
      completionNotificationsEnabled: true,
      reminderDays: [3, 1],
    });
  });

  it('honours what the organization switched off and its own reminder days', async () => {
    const { service } = build({ setting: { deadlineRemindersEnabled: false, reminderDays: [1, 7] } });
    const settings = await service.getSettings(TENANT);
    expect(settings.deadlineRemindersEnabled).toBe(false);
    expect(settings.assignmentNotificationsEnabled).toBe(true);
    expect(settings.reminderDays).toEqual([7, 1]);
  });

  it('reads a null as on', async () => {
    const built = build({ setting: { overdueRemindersEnabled: null } });
    const prefs = await learningNoticePrefs((built.service as any).modelProvider, TENANT);
    expect(prefs.overdueReminders).toBe(true);
  });
});

describe('LearningNotificationService settings', () => {
  it('creates the row on the first change and returns the new settings', async () => {
    const { service, Setting } = build();
    Setting.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await service.updateSettings(TENANT, { deadlineRemindersEnabled: false, reminderDays: [1, 5, 5] });
    expect(Setting.create).toHaveBeenCalledWith({ tenantId: TENANT, deadlineRemindersEnabled: false, reminderDays: [5, 1] });
  });

  it('updates the existing row', async () => {
    const { service, settingRow } = build({ setting: { tenantId: TENANT } });
    const result = await service.updateSettings(TENANT, { overdueRemindersEnabled: false });
    expect(settingRow.update).toHaveBeenCalledWith({ overdueRemindersEnabled: false });
    expect(result.overdueRemindersEnabled).toBe(false);
  });
});

describe('LearningNotificationService one-off notices', () => {
  it('tells each person about a new course', async () => {
    const { service, created } = build();
    await service.assigned(TENANT, [
      { employeeId: 'e-1', courseTitle: 'Safety', mandatory: true, dueDate: '2026-11-10' },
      { employeeId: 'e-2', courseTitle: 'Safety', mandatory: true, dueDate: '2026-11-10' },
    ]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ tenantId: TENANT, employeeId: 'e-1', kind: 'LEARNING', title: 'New training: Safety' });
    expect(created[0].body).toContain('Mandatory');
    expect(created[0].body).toContain('10 Nov 2026');
  });

  it('writes nothing when assignment notices are off', async () => {
    const { service, created } = build({ setting: { assignmentNotificationsEnabled: false } });
    await service.assigned(TENANT, [{ employeeId: 'e-1', courseTitle: 'Safety', mandatory: false, dueDate: null }]);
    await service.cancelled(TENANT, { employeeId: 'e-1', courseTitle: 'Safety' }, null);
    expect(created).toHaveLength(0);
  });

  it('never throws when the notification cannot be saved', async () => {
    const { service } = build({ failWrite: true });
    await expect(service.assigned(TENANT, [{ employeeId: 'e-1', courseTitle: 'Safety', mandatory: false, dueDate: null }])).resolves.toBeUndefined();
  });

  it('says what changed on an assignment, and nothing when nothing did', async () => {
    const { service, created } = build();
    await service.changed(TENANT, { employeeId: 'e-1', courseTitle: 'Safety', mandatory: false, dueDate: '2026-12-01' }, { dueDate: true, mandatory: true });
    expect(created).toHaveLength(1);
    expect(created[0].body).toContain('1 Dec 2026');
    expect(created[0].body).toContain('optional');
    await service.changed(TENANT, { employeeId: 'e-1', courseTitle: 'Safety', mandatory: false, dueDate: null }, { dueDate: false, mandatory: false });
    expect(created).toHaveLength(1);
  });

  it('includes the reason when a course is withdrawn', async () => {
    const { service, created } = build();
    await service.cancelled(TENANT, { employeeId: 'e-1', courseTitle: 'Safety' }, 'Role changed');
    expect(created[0].title).toBe('Training withdrawn: Safety');
    expect(created[0].body).toContain('Role changed');
  });

  it('tells the manager when a mandatory course is finished, on time or late', async () => {
    const { service, created } = build({ people: [person()] });
    await service.completed(TENANT, { employeeId: 'e-1', courseTitle: 'Safety', mandatory: true, dueDate: '2026-11-10', completedAt: new Date('2026-11-09T10:00:00Z') });
    await service.completed(TENANT, { employeeId: 'e-1', courseTitle: 'Safety', mandatory: true, dueDate: '2026-11-10', completedAt: new Date('2026-11-12T10:00:00Z') });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ employeeId: 'm-1', title: 'Ayesha Khan completed Safety' });
    expect(created[0].body).toContain('on time');
    expect(created[1].body).toContain('late');
  });

  it('does not tell anyone about an optional course, or a person with no manager', async () => {
    const { service, created } = build({ people: [person('e-1', null), person('e-2')] });
    await service.completed(TENANT, { employeeId: 'e-2', courseTitle: 'Safety', mandatory: false, dueDate: null, completedAt: new Date() });
    await service.completed(TENANT, { employeeId: 'e-1', courseTitle: 'Safety', mandatory: true, dueDate: '2026-11-10', completedAt: new Date() });
    expect(created).toHaveLength(0);
  });
});

describe('LearningNotificationService.sendReminders', () => {
  const TODAY = '2026-11-08';

  it('sends one deadline reminder when the due date comes within a threshold, and remembers it', async () => {
    const row = assignment({ dueDate: '2026-11-10' });
    const { service, created } = build({ open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(1);
    expect(created[0]).toMatchObject({ employeeId: 'e-1', kind: 'LEARNING', title: 'Training due in 2 days: Safety' });
    expect(row.update).toHaveBeenCalledWith({ remindersSent: [3] });

    // The next run finds the stamp and stays quiet.
    expect(await service.sendReminders(TENANT, TODAY)).toBe(0);
  });

  it('sends the next threshold when it is reached', async () => {
    const row = assignment({ dueDate: '2026-11-09', remindersSent: [3] });
    const { service, created } = build({ open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(1);
    expect(created[0].title).toBe('Training due tomorrow: Safety');
    expect(row.update).toHaveBeenCalledWith({ remindersSent: [3, 1] });
  });

  it('says today on the due date', async () => {
    const row = assignment({ dueDate: TODAY, remindersSent: [3] });
    const { service, created } = build({ open: [row], people: [person()] });
    await service.sendReminders(TENANT, TODAY);
    expect(created[0].title).toBe('Training due today: Safety');
  });

  it('does not remind someone whose due date is further away than any threshold', async () => {
    const row = assignment({ dueDate: '2026-11-20' });
    const { service, created } = build({ open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(0);
    expect(created).toHaveLength(0);
    expect(row.update).not.toHaveBeenCalled();
  });

  it('tells the person and, for a mandatory course, their manager once it is overdue', async () => {
    const row = assignment({ dueDate: '2026-11-05' });
    const { service, created } = build({ open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(2);
    expect(created.map((notice) => notice.employeeId)).toEqual(['e-1', 'm-1']);
    expect(created[0].title).toBe('Training overdue: Safety');
    expect(created[0].body).toContain('3 days ago');
    expect(created[1].title).toContain('Ayesha Khan');
    expect(row.update).toHaveBeenCalledWith({ overdueNoticeSent: true });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(0);
  });

  it('does not bother the manager about an optional course', async () => {
    const row = assignment({ dueDate: '2026-11-05', mandatory: false });
    const { service, created } = build({ open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(1);
    expect(created[0].employeeId).toBe('e-1');
  });

  it('skips people who no longer work here', async () => {
    const row = assignment({ dueDate: '2026-11-05' });
    const { service, created } = build({ open: [row], people: [] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('honours the switches', async () => {
    const upcoming = assignment({ id: 'a-1', dueDate: '2026-11-10' });
    const overdue = assignment({ id: 'a-2', dueDate: '2026-11-05' });
    const { service, created } = build({ setting: { deadlineRemindersEnabled: false }, open: [upcoming, overdue], people: [person()] });
    await service.sendReminders(TENANT, TODAY);
    expect(created.every((notice) => notice.title.startsWith('Training overdue') || notice.title.startsWith('Overdue mandatory'))).toBe(true);

    const none = build({ setting: { deadlineRemindersEnabled: false, overdueRemindersEnabled: false }, open: [upcoming] });
    expect(await none.service.sendReminders(TENANT, TODAY)).toBe(0);
    expect(none.Assignment.findAll).not.toHaveBeenCalled();
  });

  it('keeps nothing stamped when the notices could not be saved, so the next run tries again', async () => {
    const row = assignment({ dueDate: '2026-11-10' });
    const { service } = build({ open: [row], people: [person()], failWrite: true });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(0);
    expect(row.update).not.toHaveBeenCalled();
  });

  it('uses the organization\'s own reminder days', async () => {
    const row = assignment({ dueDate: '2026-11-15' });
    const { service, created } = build({ setting: { reminderDays: [7] }, open: [row], people: [person()] });
    expect(await service.sendReminders(TENANT, TODAY)).toBe(1);
    expect(created[0].title).toBe('Training due in 7 days: Safety');
    expect(row.update).toHaveBeenCalledWith({ remindersSent: [7] });
  });
});
