import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { parseUserAgent, VapidConfig, WebPushSubscription, WebPushUtil } from '@app/common';
import {
  NotificationPreferences,
  PlatformNotification,
  PlatformNotificationCategory,
  PlatformNotificationPushState,
  PushSubscription,
  SuperAdmin,
} from '../models';
import { MailService } from './mail.service';
import { DigestFrequency, inQuietHours, latestDigestSlot, localClock, QuietHours, utcOffsetMinutes } from './notification-schedule';

/** Something worth telling Super Admins about. */
export interface PlatformNotificationEvent {
  category: PlatformNotificationCategory;
  title: string;
  body: string;
  /** App path to open, e.g. `/organizations`. */
  url?: string;
  /** One recipient (their own account's security events); omitted means every active Super Admin. */
  superAdminId?: string;
}

/** Which Profile › Notifications toggle governs each category. */
const CATEGORY_PREFERENCE: Record<PlatformNotificationCategory, keyof NotificationPreferences> = {
  [PlatformNotificationCategory.SECURITY]: 'securityAlerts',
  [PlatformNotificationCategory.ACCOUNT]: 'accountUpdates',
  [PlatformNotificationCategory.SYSTEM]: 'systemAnnouncements',
  [PlatformNotificationCategory.REPORTS]: 'reportsAnalytics',
};

const CATEGORY_LABEL: Record<PlatformNotificationCategory, string> = {
  [PlatformNotificationCategory.SECURITY]: 'Security alerts',
  [PlatformNotificationCategory.ACCOUNT]: 'Account updates',
  [PlatformNotificationCategory.SYSTEM]: 'System announcements',
  [PlatformNotificationCategory.REPORTS]: 'Reports & analytics',
};

const TICK_MS = 60_000;
/** Bell history kept per Super Admin. */
const RETENTION_DAYS = 90;
/** A browser that has failed this many deliveries in a row is dropped. */
const MAX_PUSH_FAILURES = 10;

const DEFAULT_PREFERENCES = {
  accountUpdates: true,
  securityAlerts: true,
  systemAnnouncements: true,
  reportsAnalytics: true,
  pushNotifications: true,
  notificationFrequency: 'realtime',
  quietHoursEnabled: false,
  quietHoursStartTime: '22:00',
  quietHoursEndTime: '07:00',
} as const;

type Preferences = Pick<NotificationPreferences, keyof typeof DEFAULT_PREFERENCES>;

const quietOf = (prefs: Preferences): QuietHours => ({
  enabled: prefs.quietHoursEnabled,
  start: prefs.quietHoursStartTime,
  end: prefs.quietHoursEndTime,
});

const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Super Admin notifications end to end: the bell's list and read state,
 * browser push (per Profile › Notifications: categories, real-time vs
 * digest, quiet hours) and the daily/weekly email digest.
 *
 * Delivery rules:
 * - A category switched off creates nothing at all — not even a bell entry.
 * - Real-time + push on: each notification is pushed to every browser the
 *   admin enabled push in. During quiet hours it's held, and one summary push
 *   goes out when they end.
 * - Daily / weekly: no individual pushes; one email at 09:00 local (Monday
 *   for weekly), or as soon after as quiet hours allow.
 * - Times are the admin's profile time zone, not the server's.
 */
@Injectable()
export class PlatformNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformNotificationService.name);
  private vapid: VapidConfig | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastPruneDay = '';

  constructor(
    @InjectModel(PlatformNotification) private readonly notificationModel: typeof PlatformNotification,
    @InjectModel(PushSubscription) private readonly subscriptionModel: typeof PushSubscription,
    @InjectModel(NotificationPreferences) private readonly preferencesModel: typeof NotificationPreferences,
    @InjectModel(SuperAdmin) private readonly superAdminModel: typeof SuperAdmin,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.vapid = this.loadVapid();
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private loadVapid(): VapidConfig | null {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    if (!publicKey || !privateKey) {
      this.logger.warn('Browser push is off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable it.');
      return null;
    }
    const subject =
      this.config.get<string>('VAPID_SUBJECT')?.trim() ||
      `mailto:${this.config.get<string>('MAIL_FROM_ADDRESS') || this.config.get<string>('MAIL_FROM') || 'admin@localhost'}`;
    const vapid = { publicKey, privateKey, subject };
    try {
      WebPushUtil.assertVapidKeys(vapid);
      return vapid;
    } catch (error: any) {
      this.logger.error(`Browser push is off: ${error.message}`);
      return null;
    }
  }

  // ==========================================
  // Creating notifications
  // ==========================================

  /** Never throws: a notification that can't be delivered must not fail the action it reports. */
  async notify(event: PlatformNotificationEvent): Promise<number> {
    try {
      const admins = await this.superAdminModel.findAll({
        where: event.superAdminId ? { id: event.superAdminId } : { status: 'active' },
        attributes: ['id', 'timezone'],
      });
      const prefs = await this.preferencesFor(admins.map((a) => a.id));
      const now = new Date();
      let created = 0;

      for (const admin of admins) {
        const pref = prefs.get(admin.id)!;
        if (pref[CATEGORY_PREFERENCE[event.category]] === false) continue;

        const realtime = pref.notificationFrequency === 'realtime';
        const quiet = inQuietHours(quietOf(pref), localClock(now, utcOffsetMinutes(admin.timezone, now)).minutes);
        const wantsPush = realtime && pref.pushNotifications && this.vapid !== null;

        const row = await this.notificationModel.create({
          superAdminId: admin.id,
          category: event.category,
          title: event.title.slice(0, 160),
          body: event.body,
          url: event.url ?? null,
          pushState: wantsPush ? (quiet ? PlatformNotificationPushState.HELD : PlatformNotificationPushState.SENT) : PlatformNotificationPushState.NONE,
          // Digest admins get it in their next email instead of a push.
          digestedAt: realtime ? now : null,
        });
        created += 1;

        if (wantsPush && !quiet) {
          await this.pushToAdmin(admin.id, {
            id: row.id,
            title: row.title,
            body: row.body,
            url: row.url ?? '/',
            tag: row.id,
          });
          await row.update({ pushedAt: new Date() });
        }
      }
      return created;
    } catch (error: any) {
      this.logger.error(`Could not record notification "${event.title}": ${error?.message ?? error}`);
      return 0;
    }
  }

  private async preferencesFor(adminIds: string[]): Promise<Map<string, Preferences>> {
    const rows = adminIds.length
      ? await this.preferencesModel.findAll({ where: { superAdminId: { [Op.in]: adminIds } } })
      : [];
    const map = new Map<string, Preferences>();
    for (const id of adminIds) {
      const row = rows.find((r) => r.superAdminId === id);
      map.set(id, row ? (row.get({ plain: true }) as Preferences) : { ...DEFAULT_PREFERENCES });
    }
    return map;
  }

  // ==========================================
  // The bell
  // ==========================================

  async list(superAdminId: string, limit = 20) {
    const take = Math.min(Math.max(limit, 1), 50);
    const [rows, unreadCount, admin, prefs] = await Promise.all([
      this.notificationModel.findAll({
        where: { superAdminId },
        order: [['createdAt', 'DESC']],
        limit: take,
      }),
      this.notificationModel.count({ where: { superAdminId, readAt: null } }),
      this.superAdminModel.findByPk(superAdminId, { attributes: ['id', 'timezone'] }),
      this.preferencesFor([superAdminId]),
    ]);
    const pref = prefs.get(superAdminId)!;
    const now = new Date();
    const quietActive = inQuietHours(quietOf(pref), localClock(now, utcOffsetMinutes(admin?.timezone, now)).minutes);

    return {
      success: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          category: r.category,
          title: r.title,
          body: r.body,
          url: r.url,
          unread: !r.readAt,
          createdAt: r.createdAt,
        })),
        unreadCount,
        // Decided here, in the admin's profile time zone, so the bell and
        // push agree on when quiet hours are on.
        quietHours: { active: quietActive, until: quietActive ? pref.quietHoursEndTime : null },
      },
    };
  }

  async markRead(superAdminId: string, id: string) {
    const [count] = await this.notificationModel.update(
      { readAt: new Date() },
      { where: { id, superAdminId, readAt: null } },
    );
    return { success: true, updated: count };
  }

  async markAllRead(superAdminId: string) {
    const [count] = await this.notificationModel.update({ readAt: new Date() }, { where: { superAdminId, readAt: null } });
    return { success: true, updated: count };
  }

  // ==========================================
  // Browser push
  // ==========================================

  pushConfig() {
    return { success: true, data: { enabled: this.vapid !== null, publicKey: this.vapid?.publicKey ?? null } };
  }

  async subscribe(superAdminId: string, subscription: WebPushSubscription, userAgent?: string) {
    if (!this.vapid) throw new BadRequestException('Browser push is not configured on this server.');
    if (!/^https:\/\//.test(subscription.endpoint)) throw new BadRequestException('Push endpoint must be an https URL.');
    try {
      // Rejects keys the browser could never have produced, before storing them.
      WebPushUtil.encrypt(subscription, Buffer.from('probe'));
    } catch {
      throw new BadRequestException('The browser sent an invalid push subscription.');
    }

    const { browser, operatingSystem } = parseUserAgent(userAgent);
    const deviceLabel = [browser, operatingSystem].filter((p) => p && !/^unknown/i.test(p)).join(' on ') || null;
    const existing = await this.subscriptionModel.findOne({ where: { endpoint: subscription.endpoint } });
    const values = {
      superAdminId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      deviceLabel,
      failureCount: 0,
    };
    if (existing) await existing.update(values);
    else await this.subscriptionModel.create(values);
    return { success: true, devices: await this.subscriptionModel.count({ where: { superAdminId } }) };
  }

  async unsubscribe(superAdminId: string, endpoint: string) {
    await this.subscriptionModel.destroy({ where: { superAdminId, endpoint } });
    return { success: true, devices: await this.subscriptionModel.count({ where: { superAdminId } }) };
  }

  async sendTest(superAdminId: string) {
    if (!this.vapid) throw new BadRequestException('Browser push is not configured on this server.');
    const devices = await this.subscriptionModel.count({ where: { superAdminId } });
    if (!devices) throw new NotFoundException('Push notifications are not turned on in any of your browsers yet.');
    const delivered = await this.pushToAdmin(superAdminId, {
      title: 'Test notification',
      body: 'Push notifications are working on this device.',
      url: '/profile',
      tag: 'test',
    });
    return { success: true, devices, delivered };
  }

  /** Sends to every browser the admin enabled; returns how many accepted it. */
  private async pushToAdmin(superAdminId: string, payload: Record<string, unknown>): Promise<number> {
    if (!this.vapid) return 0;
    const subscriptions = await this.subscriptionModel.findAll({ where: { superAdminId } });
    let delivered = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        const result = await WebPushUtil.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          this.vapid!,
          { urgency: 'normal', topic: typeof payload.tag === 'string' ? payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : undefined },
        );
        if (result.ok) {
          delivered += 1;
          await sub.update({ lastSuccessAt: new Date(), failureCount: 0 });
        } else if (result.expired || sub.failureCount + 1 >= MAX_PUSH_FAILURES) {
          await sub.destroy();
          this.logger.log(`Removed push subscription ${sub.id} (${result.expired ? 'expired' : 'kept failing'}).`);
        } else {
          await sub.update({ failureCount: sub.failureCount + 1 });
          this.logger.warn(`Push to subscription ${sub.id} failed (${result.statusCode}): ${result.body ?? ''}`);
        }
      }),
    );
    return delivered;
  }

  // ==========================================
  // Scheduled work: held pushes, digests, retention
  // ==========================================

  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.releaseHeldPushes(now);
      await this.sendDueDigests(now);
      await this.prune(now);
    } catch (error: any) {
      this.logger.error(`Notification scheduler failed: ${error?.message ?? error}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Quiet hours over: one summary push per admin for what was held. */
  private async releaseHeldPushes(now: Date) {
    const held = await this.notificationModel.findAll({
      where: { pushState: PlatformNotificationPushState.HELD },
      order: [['createdAt', 'ASC']],
    });
    if (!held.length) return;

    const byAdmin = new Map<string, PlatformNotification[]>();
    for (const row of held) byAdmin.set(row.superAdminId, [...(byAdmin.get(row.superAdminId) ?? []), row]);
    const admins = await this.superAdminModel.findAll({ where: { id: [...byAdmin.keys()] }, attributes: ['id', 'timezone'] });
    const prefs = await this.preferencesFor(admins.map((a) => a.id));

    for (const admin of admins) {
      const rows = byAdmin.get(admin.id)!;
      const pref = prefs.get(admin.id)!;
      const stillWanted = pref.pushNotifications && pref.notificationFrequency === 'realtime' && this.vapid !== null;
      if (stillWanted && inQuietHours(quietOf(pref), localClock(now, utcOffsetMinutes(admin.timezone, now)).minutes)) continue;

      if (stillWanted) {
        const unread = rows.filter((r) => !r.readAt);
        if (unread.length === 1) {
          const [only] = unread;
          await this.pushToAdmin(admin.id, { id: only.id, title: only.title, body: only.body, url: only.url ?? '/', tag: only.id });
        } else if (unread.length > 1) {
          await this.pushToAdmin(admin.id, {
            title: `${unread.length} notifications during quiet hours`,
            body: unread
              .slice(-3)
              .map((r) => r.title)
              .join(' · '),
            url: '/',
            tag: 'quiet-hours-summary',
          });
        }
      }
      await this.notificationModel.update(
        { pushState: stillWanted ? PlatformNotificationPushState.SENT : PlatformNotificationPushState.NONE, pushedAt: stillWanted ? now : null },
        { where: { id: rows.map((r) => r.id) } },
      );
    }
  }

  /** Emails each digest admin whatever was created before their latest 09:00 slot and not yet sent. */
  private async sendDueDigests(now: Date) {
    const digestPrefs = await this.preferencesModel.findAll({
      where: { notificationFrequency: { [Op.in]: ['daily', 'weekly'] } },
    });
    // Notifications owed by admins who have since switched back to real-time
    // were already in their bell; they're not owed an email any more.
    await this.notificationModel.update(
      { digestedAt: now },
      {
        where: {
          digestedAt: null,
          ...(digestPrefs.length ? { superAdminId: { [Op.notIn]: digestPrefs.map((p) => p.superAdminId) } } : {}),
        },
      },
    );
    if (!digestPrefs.length) return;

    const admins = await this.superAdminModel.findAll({
      where: { id: digestPrefs.map((p) => p.superAdminId), status: 'active' },
      attributes: ['id', 'email', 'firstName', 'name', 'timezone'],
    });

    for (const admin of admins) {
      const pref = digestPrefs.find((p) => p.superAdminId === admin.id)!;
      const offset = utcOffsetMinutes(admin.timezone, now);
      if (inQuietHours(quietOf(pref), localClock(now, offset).minutes)) continue;

      const frequency = pref.notificationFrequency as DigestFrequency;
      const slot = latestDigestSlot(frequency, now, offset);
      const rows = await this.notificationModel.findAll({
        where: { superAdminId: admin.id, digestedAt: null, createdAt: { [Op.lt]: slot } },
        order: [['createdAt', 'ASC']],
        limit: 200,
      });
      if (!rows.length) continue;

      const sent = await this.emailDigest(admin, frequency, rows, offset);
      if (sent) {
        await this.notificationModel.update({ digestedAt: now }, { where: { id: rows.map((r) => r.id) } });
      }
    }
  }

  private async emailDigest(admin: SuperAdmin, frequency: DigestFrequency, rows: PlatformNotification[], offset: number) {
    const appUrl = (this.config.get<string>('FRONTEND_URL') || '').replace(/\/+$/, '');
    const formatTime = (at: Date) =>
      new Date(at.getTime() + offset * 60_000).toLocaleString('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      });
    const groups = (Object.values(PlatformNotificationCategory) as PlatformNotificationCategory[])
      .map((category) => ({ category, items: rows.filter((r) => r.category === category) }))
      .filter((g) => g.items.length);

    const sectionsHtml = groups
      .map(
        (g) => `
          <h3 style="color:#0f172a;font-size:15px;margin:24px 0 8px;">${escapeHtml(CATEGORY_LABEL[g.category])} (${g.items.length})</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            ${g.items
              .map(
                (r) => `<tr>
                  <td style="padding:8px 0;border-top:1px solid #e2e8f0;vertical-align:top;">
                    <div style="color:#0f172a;font-weight:600;">${escapeHtml(r.title)}</div>
                    <div style="color:#475569;">${escapeHtml(r.body)}</div>
                  </td>
                  <td style="padding:8px 0 8px 12px;border-top:1px solid #e2e8f0;color:#94a3b8;white-space:nowrap;vertical-align:top;text-align:right;">${escapeHtml(formatTime(r.createdAt))}</td>
                </tr>`,
              )
              .join('')}
          </table>`,
      )
      .join('');
    const period = frequency === 'daily' ? 'daily' : 'weekly';
    const message = `
      <p>Hello ${escapeHtml(admin.firstName || admin.name || 'there')},</p>
      <p>Here is your ${period} summary: ${rows.length} notification${rows.length === 1 ? '' : 's'} since your last digest.</p>
      ${sectionsHtml}
      ${appUrl ? `<div style="text-align:center;margin:28px 0 8px;"><a href="${escapeHtml(appUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Open the platform</a></div>` : ''}
      <p style="color:#94a3b8;font-size:12px;">You get this ${period} because of your Profile › Notifications settings. Change the frequency there to switch it off.</p>`;
    const text = [
      `Your ${period} notification summary (${rows.length}):`,
      ...groups.flatMap((g) => [`\n${CATEGORY_LABEL[g.category]}:`, ...g.items.map((r) => `- ${r.title} — ${r.body} (${formatTime(r.createdAt)})`)]),
    ].join('\n');

    const result = await this.mailService.sendTemplateEmail({
      to: admin.email,
      subject: `Your ${period} notification summary — ${rows.length} update${rows.length === 1 ? '' : 's'}`,
      templateName: 'notification_digest',
      variables: { title: `Your ${period} summary`, messageHtml: message, messageText: text },
    });
    if (!result.success) this.logger.warn(`Digest email to ${admin.email} failed: ${result.error ?? 'unknown error'}`);
    return result.success;
  }

  /** Once a day: drop bell history past the retention window. */
  private async prune(now: Date) {
    const day = now.toISOString().slice(0, 10);
    if (day === this.lastPruneDay) return;
    this.lastPruneDay = day;
    await this.notificationModel.destroy({
      where: { createdAt: { [Op.lt]: new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000) } },
    });
  }
}
