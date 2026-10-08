import { WebPushUtil } from '@app/common';
import { PlatformNotificationCategory, PlatformNotificationPushState } from '../models';
import { PlatformNotificationService } from './platform-notification.service';

/** Just enough of a Sequelize model, held in memory. */
const fakeModel = <T extends Record<string, any>>(rows: T[] = []) => {
  const matches = (row: T, where: Record<string, any> = {}) =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
        const ops = Object.getOwnPropertySymbols(cond);
        return ops.every((op) => {
          const value = (cond as any)[op];
          switch (op.description) {
            case 'in':
              return value.includes(row[key]);
            case 'notIn':
              return !value.includes(row[key]);
            case 'lt':
              return row[key] < value;
            default:
              throw new Error(`fake op ${op.description}`);
          }
        });
      }
      if (Array.isArray(cond)) return cond.includes(row[key]);
      return (row[key] ?? null) === cond;
    });
  const wrap = (row: T) =>
    Object.assign(row, {
      update: async (patch: Partial<T>) => Object.assign(row, patch),
      destroy: async () => rows.splice(rows.indexOf(row), 1),
      get: () => ({ ...row }),
    });
  return {
    rows,
    findAll: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).map(wrap),
    findOne: async ({ where }: any = {}) => rows.map(wrap).find((r) => matches(r, where)) ?? null,
    findByPk: async (id: string) => rows.map(wrap).find((r) => r.id === id) ?? null,
    count: async ({ where }: any = {}) => rows.filter((r) => matches(r, where)).length,
    create: async (values: any) => {
      const row = wrap({ id: `n${rows.length + 1}`, readAt: null, pushedAt: null, createdAt: new Date(NOW), ...values });
      rows.push(row);
      return row;
    },
    update: async (patch: any, { where }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return [hit.length];
    },
    destroy: async ({ where }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return hit.length;
    },
  };
};

// 14:00 Karachi (09:00 UTC), Thursday 8 Oct 2026.
const NOW = new Date('2026-10-08T09:00:00Z');
const vapid = WebPushUtil.generateVapidKeys();

const setup = (prefs: Record<string, any> = {}) => {
  const admins = fakeModel([{ id: 'a1', status: 'active', timezone: 'UTC+05:00 (Asia/Karachi)', email: 'sa@example.com', firstName: 'Sana' }]);
  const preferences = fakeModel([
    {
      superAdminId: 'a1',
      accountUpdates: true,
      securityAlerts: true,
      systemAnnouncements: true,
      reportsAnalytics: true,
      pushNotifications: true,
      notificationFrequency: 'realtime',
      quietHoursEnabled: false,
      quietHoursStartTime: '22:00',
      quietHoursEndTime: '07:00',
      ...prefs,
    },
  ]);
  const notifications = fakeModel<any>();
  const subscriptions = fakeModel([{ id: 's1', superAdminId: 'a1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a', failureCount: 0 }]);
  const mail = { sendTemplateEmail: jest.fn().mockResolvedValue({ success: true }) };
  const config = { get: (key: string) => ({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:ops@example.com' })[key] };

  const service = new PlatformNotificationService(
    notifications as any,
    subscriptions as any,
    preferences as any,
    admins as any,
    mail as any,
    config as any,
  );
  service.onModuleInit();
  const push = jest.spyOn(WebPushUtil, 'send').mockResolvedValue({ ok: true, statusCode: 201, expired: false });
  return { service, notifications, mail, push };
};

const event = { category: PlatformNotificationCategory.SECURITY, title: 'New sign-in', body: 'Chrome on Windows', superAdminId: 'a1' };

describe('PlatformNotificationService', () => {
  beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterAll(() => jest.useRealTimers());
  afterEach(() => jest.restoreAllMocks());

  it('creates nothing for a category the admin switched off', async () => {
    const { service, notifications, push } = setup({ securityAlerts: false });
    expect(await service.notify(event)).toBe(0);
    expect(notifications.rows).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('pushes a real-time notification straight away', async () => {
    const { service, notifications, push } = setup();
    await service.notify(event);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toMatchObject({ title: 'New sign-in', body: 'Chrome on Windows' });
    expect(notifications.rows[0].pushState).toBe(PlatformNotificationPushState.SENT);
  });

  it('holds pushes during quiet hours and sends one summary when they end', async () => {
    // Quiet 13:00–15:00 Karachi; it is 14:00.
    const { service, notifications, push } = setup({ quietHoursEnabled: true, quietHoursStartTime: '13:00', quietHoursEndTime: '15:00' });
    await service.notify(event);
    await service.notify({ ...event, title: 'Failed sign-in attempt' });
    expect(push).not.toHaveBeenCalled();
    expect(notifications.rows.every((r: any) => r.pushState === PlatformNotificationPushState.HELD)).toBe(true);

    // Still quiet: nothing released.
    await service.tick(new Date('2026-10-08T09:30:00Z'));
    expect(push).not.toHaveBeenCalled();

    // 15:05 Karachi: one summary for both.
    await service.tick(new Date('2026-10-08T10:05:00Z'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toMatchObject({ title: '2 notifications during quiet hours' });
    expect(notifications.rows.every((r: any) => r.pushState === PlatformNotificationPushState.SENT)).toBe(true);
  });

  it('daily digest: no push, then one email after the next 09:00', async () => {
    const { service, notifications, mail, push } = setup({ notificationFrequency: 'daily' });
    await service.notify(event);
    expect(push).not.toHaveBeenCalled();
    expect(notifications.rows[0].digestedAt).toBeNull();

    // Same afternoon: today's 09:00 slot was before the notification, so nothing is due.
    await service.tick(new Date('2026-10-08T12:00:00Z'));
    expect(mail.sendTemplateEmail).not.toHaveBeenCalled();

    // Next morning 09:10 Karachi.
    await service.tick(new Date('2026-10-09T04:10:00Z'));
    expect(mail.sendTemplateEmail).toHaveBeenCalledTimes(1);
    const sent = mail.sendTemplateEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ to: 'sa@example.com', templateName: 'notification_digest' });
    expect(sent.variables.messageHtml).toContain('New sign-in');
    expect(notifications.rows[0].digestedAt).not.toBeNull();

    // Not sent twice.
    await service.tick(new Date('2026-10-09T04:20:00Z'));
    expect(mail.sendTemplateEmail).toHaveBeenCalledTimes(1);
  });

  it('marks read and reports quiet hours with the unread count', async () => {
    const { service } = setup({ quietHoursEnabled: true, quietHoursStartTime: '13:00', quietHoursEndTime: '15:00' });
    await service.notify(event);
    let list = await service.list('a1');
    expect(list.data.unreadCount).toBe(1);
    expect(list.data.quietHours).toEqual({ active: true, until: '15:00' });

    await service.markAllRead('a1');
    list = await service.list('a1');
    expect(list.data.unreadCount).toBe(0);
  });
});
