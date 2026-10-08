import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { MESSAGE_PATTERNS, PlatformNotificationCategory, PlatformNotifyPayloadDto, SERVICES } from '@app/common';
import { BillingEvent, Tenant } from '../models';

/** Billing events worth a Super Admin's attention, and how to say them. */
const BILLING_NOTICES: Record<string, { title: (org: string) => string; body: (e: BillingEvent) => string }> = {
  PAYMENT_SUCCESS: { title: (org) => `Payment received from ${org}`, body: (e) => e.description || 'A subscription payment succeeded.' },
  PAYMENT_FAILED: { title: (org) => `Payment failed for ${org}`, body: (e) => e.description || 'A subscription payment did not go through.' },
  SUBSCRIPTION_ACTIVATED: { title: (org) => `${org}'s subscription is active`, body: (e) => e.description || 'The subscription was activated.' },
  SUBSCRIPTION_PAST_DUE: { title: (org) => `${org} is past due`, body: (e) => e.description || 'An invoice is unpaid past its due date.' },
  INVOICE_OVERDUE: { title: (org) => `Overdue invoice for ${org}`, body: (e) => e.description || 'An invoice is overdue.' },
  SUBSCRIPTION_SUSPENDED: { title: (org) => `${org}'s subscription was suspended`, body: (e) => e.description || 'The grace period ran out.' },
};

/**
 * Tells Super Admins about organization and billing events, through the auth
 * service's notification system (bell, browser push, email digest).
 *
 * Fire-and-forget: a notification that can't be delivered must never fail
 * the action it reports, so nothing here throws or is awaited by callers.
 */
@Injectable()
export class PlatformNotifierService implements OnModuleInit {
  private readonly logger = new Logger(PlatformNotifierService.name);

  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @InjectModel(BillingEvent) private readonly billingEventModel: typeof BillingEvent,
    @InjectModel(Tenant) private readonly tenantModel: typeof Tenant,
  ) {}

  /**
   * Billing events are written from a dozen places (payments, the scheduler,
   * invoices); one hook on the table covers every one of them, including
   * future ones.
   */
  onModuleInit() {
    this.billingEventModel.addHook('afterCreate', 'platformNotifications', (event: BillingEvent) => {
      const notice = BILLING_NOTICES[event.eventType];
      if (!notice) return;
      void this.organizationName(event.tenantId).then((org) =>
        this.notify({
          category: PlatformNotificationCategory.ACCOUNT,
          title: notice.title(org),
          body: notice.body(event),
          url: '/subscriptions',
        }),
      );
    });
  }

  async organizationName(tenantId: string | null | undefined): Promise<string> {
    if (!tenantId) return 'An organization';
    const tenant = await this.tenantModel
      .findByPk(tenantId, { attributes: ['organizationName', 'name'] })
      .catch(() => null);
    return tenant?.organizationName || tenant?.name || 'An organization';
  }

  /** Account-category notice for every Super Admin. */
  account(title: string, body: string, url = '/organizations') {
    void this.notify({ category: PlatformNotificationCategory.ACCOUNT, title, body, url });
  }

  async notify(event: PlatformNotifyPayloadDto): Promise<void> {
    try {
      await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.NOTIFY, event).pipe(timeout(15_000)));
    } catch (error: any) {
      this.logger.warn(`Super Admin notification "${event.title}" was not delivered: ${error?.message ?? error}`);
    }
  }
}
