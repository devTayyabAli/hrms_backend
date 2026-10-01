import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import { SubscriptionStatus, InvoiceStatus, BillingCycle } from '@app/common';
import { Subscription } from '../models/subscription.model';
import { Invoice } from '../models/invoice.model';
import { BillingEvent } from '../models/billing-event.model';
import { PlatformBillingService } from './platform-billing.service';

@Injectable()
export class BillingScheduler implements OnModuleInit {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Invoice)
    private readonly invoiceModel: typeof Invoice,
    @InjectModel(BillingEvent)
    private readonly billingEventModel: typeof BillingEvent,
    private readonly platformBillingService: PlatformBillingService,
  ) {}

  onModuleInit() {
    this.logger.log('BillingScheduler initialized. Automated subscription lifecycle monitoring active.');
  }

  /**
   * JOB 1: Detect upcoming renewals (7 days prior) and generate renewal invoices idempotently.
   * Error isolation per tenant ensures one tenant failure does not halt job execution.
   */
  async processUpcomingRenewals(thresholdDays: number = 7): Promise<{ processed: number; invoicesGenerated: number }> {
    const now = new Date();
    const thresholdDate = new Date(now.getTime() + thresholdDays * 24 * 60 * 60 * 1000);

    const activeSubs = await this.subscriptionModel.findAll({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate: {
          [Op.between]: [now, thresholdDate],
        },
      },
    });

    let invoicesGenerated = 0;

    for (const sub of activeSubs) {
      try {
        // IDEMPOTENCY CHECK: Ensure an OPEN or DRAFT invoice does not already exist
        const existingOpenInvoice = await this.invoiceModel.findOne({
          where: {
            subscriptionId: sub.id,
            status: [InvoiceStatus.OPEN, InvoiceStatus.DRAFT],
          },
        });

        if (!existingOpenInvoice) {
          const invoice = await this.platformBillingService.createInvoice(sub.tenantId, {
            subscriptionId: sub.id,
            billingCycle: sub.billingCycle,
            description: `Automated renewal invoice for subscription ${sub.id} (${sub.billingCycle})`,
          });

          invoicesGenerated++;

          await this.billingEventModel.create({
            tenantId: sub.tenantId,
            subscriptionId: sub.id,
            invoiceId: invoice.id,
            eventType: 'SUBSCRIPTION_RENEWAL_STARTED',
            description: `Upcoming subscription renewal detected. Invoice ${invoice.invoiceNumber} generated for ${sub.billingCycle} cycle.`,
          });

          this.logger.log(
            `Renewal invoice '${invoice.invoiceNumber}' created for tenant '${sub.tenantId}', subscription '${sub.id}'.`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to process upcoming renewal for tenant '${sub.tenantId}', subscription '${sub.id}': ${err.message}`,
          err.stack,
        );
      }
    }

    return { processed: activeSubs.length, invoicesGenerated };
  }

  /**
   * JOB 2: Detect overdue OPEN invoices, mark them OVERDUE, and set Subscription PAST_DUE with 7-day grace period.
   * Error isolation per tenant ensures individual failures do not interrupt overdue job.
   */
  async processOverdueInvoices(gracePeriodDays: number = 7): Promise<{ overdueInvoices: number; subscriptionsPastDue: number }> {
    const now = new Date();

    const overdueInvoices = await this.invoiceModel.findAll({
      where: {
        status: InvoiceStatus.OPEN,
        dueDate: {
          [Op.lt]: now,
        },
      },
    });

    let subscriptionsPastDue = 0;

    for (const invoice of overdueInvoices) {
      try {
        await invoice.update({ status: InvoiceStatus.OVERDUE });

        const subscription = await this.subscriptionModel.findByPk(invoice.subscriptionId);
        if (subscription && subscription.status !== SubscriptionStatus.PAST_DUE) {
          const gracePeriodEndsAt = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);

          await subscription.update({
            status: SubscriptionStatus.PAST_DUE,
            pastDueAt: now,
            gracePeriodEndsAt,
          });

          subscriptionsPastDue++;

          await this.billingEventModel.create({
            tenantId: invoice.tenantId,
            subscriptionId: invoice.subscriptionId,
            invoiceId: invoice.id,
            eventType: 'INVOICE_OVERDUE',
            description: `Invoice '${invoice.invoiceNumber}' is overdue past ${invoice.dueDate.toISOString().slice(0, 10)}.`,
          });

          await this.billingEventModel.create({
            tenantId: invoice.tenantId,
            subscriptionId: invoice.subscriptionId,
            invoiceId: invoice.id,
            eventType: 'GRACE_PERIOD_STARTED',
            description: `Subscription entered PAST_DUE status. 7-day grace period active until ${gracePeriodEndsAt.toISOString().slice(0, 10)}.`,
          });

          this.logger.warn(
            `Subscription '${subscription.id}' for tenant '${invoice.tenantId}' marked PAST_DUE. Grace period ends ${gracePeriodEndsAt.toISOString()}`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to process overdue invoice '${invoice.id}' for tenant '${invoice.tenantId}': ${err.message}`,
          err.stack,
        );
      }
    }

    return { overdueInvoices: overdueInvoices.length, subscriptionsPastDue };
  }

  /**
   * JOB 3: Detect PAST_DUE subscriptions whose gracePeriodEndsAt has expired, and mark them SUSPENDED.
   * Error isolation per tenant ensures individual failures do not interrupt suspension job.
   */
  async processSuspensions(): Promise<{ suspendedSubscriptions: number }> {
    const now = new Date();

    const expiredSubs = await this.subscriptionModel.findAll({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        gracePeriodEndsAt: {
          [Op.lt]: now,
        },
      },
    });

    let count = 0;

    for (const sub of expiredSubs) {
      try {
        await sub.update({
          status: SubscriptionStatus.SUSPENDED,
        });

        await this.billingEventModel.create({
          tenantId: sub.tenantId,
          subscriptionId: sub.id,
          eventType: 'SUBSCRIPTION_SUSPENDED',
          description: `Grace period expired on ${now.toISOString().slice(0, 10)}. Subscription SUSPENDED.`,
        });

        count++;
        this.logger.warn(`Subscription '${sub.id}' for tenant '${sub.tenantId}' SUSPENDED due to grace period expiration.`);
      } catch (err: any) {
        this.logger.error(
          `Failed to process suspension for tenant '${sub.tenantId}', subscription '${sub.id}': ${err.message}`,
          err.stack,
        );
      }
    }

    return { suspendedSubscriptions: count };
  }

  /**
   * Master execution method running all automated billing jobs
   */
  async runAllBillingJobs() {
    this.logger.log('Executing master billing automation jobs...');
    const renewals = await this.processUpcomingRenewals();
    const overdue = await this.processOverdueInvoices();
    const suspensions = await this.processSuspensions();

    return {
      timestamp: new Date(),
      renewals,
      overdue,
      suspensions,
    };
  }
}
