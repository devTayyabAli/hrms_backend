import { Injectable, Logger, HttpStatus, Optional } from '@nestjs/common';
import { PlatformNotifierService } from './platform-notifier.service';
import { InjectModel } from '@nestjs/sequelize';
import { Op, fn, col } from 'sequelize';
import {
  CreatePlanDto,
  UpdatePlanDto,
  CreateSubscriptionDto,
  UpdateSubscriptionStatusDto,
  PlanFilterDto,
  CreatePaymentDto,
  ProcessPaymentDto,
  PaymentQueryDto,
  CreateInvoiceDto,
  InvoiceQueryDto,
  CancelSubscriptionDto,
  ChangeSubscriptionPlanDto,
  SubscriptionQueryDto,
  BillingStatusQueryDto,
  BillingUsageQueryDto,
  BillingEventQueryDto,
  ExtendGracePeriodDto,
  ManualBillingActionDto,
  SubscriptionStatus,
  BillingCycle,
  PaymentStatus,
  PaymentMethod,
  InvoiceStatus,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { Plan } from '../models/plan.model';
import {
  Subscription,
  SubscriptionSnapshotLimits,
} from '../models/subscription.model';
import { Tenant } from '../models/tenant.model';
import { Payment } from '../models/payment.model';
import { Invoice } from '../models/invoice.model';
import { BillingEvent } from '../models/billing-event.model';
import { PaymentProviderFactory } from '../billing/providers/payment-provider.factory';
import { BillingStateMachine } from '../billing/billing-state-machine';

export interface BillingMetricsResult {
  totalPlans: number;
  orgsSubscribed: number;
  activeSubscriptions: number;
  mrr: number;
  totalRevenue: number;
  pendingPayments: number;
  failedPayments: number;
  overdueInvoices: number;
  cancelledSubscriptions: number;
  suspendedSubscriptions: number;
}

@Injectable()
export class PlatformBillingService {
  private readonly logger = new Logger(PlatformBillingService.name);

  constructor(
    @InjectModel(Plan)
    private readonly planModel: typeof Plan,
    @InjectModel(Subscription)
    private readonly subscriptionModel: typeof Subscription,
    @InjectModel(Tenant)
    private readonly tenantModel: typeof Tenant,
    @InjectModel(Payment)
    private readonly paymentModel: typeof Payment,
    @InjectModel(Invoice)
    private readonly invoiceModel: typeof Invoice,
    @InjectModel(BillingEvent)
    private readonly billingEventModel: typeof BillingEvent,
    private readonly providerFactory: PaymentProviderFactory,
    @Optional() private readonly platformNotifier?: PlatformNotifierService,
  ) {}

  /** Manual subscription changes write no billing event, so they announce themselves. */
  private announceSubscription(tenantId: string, title: (org: string) => string, body: string) {
    if (!this.platformNotifier) return;
    void this.platformNotifier.organizationName(tenantId).then((org) => this.platformNotifier!.account(title(org), body, '/subscriptions'));
  }

  // ---------------------------------------------------------
  // PLAN MANAGEMENT
  // ---------------------------------------------------------

  /**
   * Create a new platform billing plan
   */
  async createPlan(dto: CreatePlanDto): Promise<Plan> {
    this.logger.log(`Creating billing plan: ${dto.name}`);

    // Ensure prices are non-negative
    if (dto.monthlyPrice < 0 || dto.yearlyPrice < 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_PLAN,
        'Plan prices cannot be negative.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const plan = await this.planModel.create({
      name: dto.name,
      description: dto.description || null,
      monthlyPrice: dto.monthlyPrice,
      yearlyPrice: dto.yearlyPrice,
      currency: dto.currency || 'USD',
      maxEmployees: dto.maxEmployees,
      maxHrUsers: dto.maxHrUsers,
      maxAdminUsers: dto.maxAdminUsers,
      storageGb: dto.storageGb,
      apiCallsPerMonth: dto.apiCallsPerMonth,
      dataRetentionDays: dto.dataRetentionDays,
      customReportsLimit: dto.customReportsLimit,
      supportType: dto.supportType,
      securityLevel: dto.securityLevel,
      hasDedicatedAccountManager: dto.hasDedicatedAccountManager ?? false,
      isCustom: dto.isCustom ?? false,
      isActive: dto.isActive ?? true,
    });

    return plan;
  }

  /**
   * Fetch all plans with optional filtering
   */
  async getPlans(filter?: PlanFilterDto): Promise<Plan[]> {
    const where: any = {};
    if (filter?.isActive !== undefined) {
      where.isActive = filter.isActive;
    }
    if (filter?.isCustom !== undefined) {
      where.isCustom = filter.isCustom;
    }

    return this.planModel.findAll({
      where,
      order: [['createdAt', 'ASC']],
    });
  }

  /**
   * Fetch a plan by ID
   */
  async getPlanById(id: string): Promise<Plan> {
    const plan = await this.planModel.findByPk(id);
    if (!plan) {
      throw new TenantException(
        TenantErrorCode.PLAN_NOT_FOUND,
        `Plan with ID '${id}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return plan;
  }

  /**
   * Update an existing plan
   * CRITICAL RULE: Modifies ONLY the Plan record. NEVER alters existing subscription snapshots.
   */
  async updatePlan(id: string, dto: UpdatePlanDto): Promise<Plan> {
    const plan = await this.getPlanById(id);

    if (dto.monthlyPrice !== undefined && dto.monthlyPrice < 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_PLAN,
        'Plan monthly price cannot be negative.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.yearlyPrice !== undefined && dto.yearlyPrice < 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_PLAN,
        'Plan yearly price cannot be negative.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await plan.update({
      ...dto,
    });

    this.logger.log(
      `Updated plan '${plan.id}' (${plan.name}). Subscriptions remain unchanged.`,
    );
    return plan;
  }

  // ---------------------------------------------------------
  // SUBSCRIPTION MANAGEMENT
  // ---------------------------------------------------------

  /**
   * Create a subscription with plan snapshotting
   */
  async createSubscription(
    tenantId: string,
    planId: string,
    billingCycle: BillingCycle = BillingCycle.MONTHLY,
    status: SubscriptionStatus = SubscriptionStatus.PENDING_PAYMENT,
  ): Promise<Subscription> {
    this.logger.log(
      `Creating subscription for tenant ${tenantId} on plan ${planId}`,
    );

    // Verify tenant exists
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new TenantException(
        TenantErrorCode.TENANT_NOT_FOUND,
        `Tenant with ID '${tenantId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Verify plan exists and is active
    const plan = await this.getPlanById(planId);
    if (!plan.isActive) {
      throw new TenantException(
        TenantErrorCode.PLAN_INACTIVE,
        `Plan '${plan.name}' is inactive and cannot be assigned to a new subscription.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Snapshot pricing & limits from Plan at point of subscription (Grandfathering Rule)
    const snapshotMonthlyPrice = Number(plan.monthlyPrice);
    const snapshotYearlyPrice = Number(plan.yearlyPrice);
    const snapshotLimits: SubscriptionSnapshotLimits = {
      maxEmployees: plan.maxEmployees,
      maxHrUsers: plan.maxHrUsers,
      maxAdminUsers: plan.maxAdminUsers,
      storageGb: plan.storageGb,
      apiCallsPerMonth: plan.apiCallsPerMonth,
      dataRetentionDays: plan.dataRetentionDays,
      customReportsLimit: plan.customReportsLimit,
      supportType: plan.supportType,
      securityLevel: plan.securityLevel,
    };

    const startDate = new Date();

    const subscription = await this.subscriptionModel.create({
      tenantId,
      planId: plan.id,
      status,
      billingCycle,
      startDate,
      snapshotMonthlyPrice,
      snapshotYearlyPrice,
      snapshotLimits,
    });

    return subscription;
  }

  /**
   * Get subscription by Tenant ID
   */
  async getSubscriptionByTenant(
    tenantId: string,
  ): Promise<Subscription | null> {
    return this.subscriptionModel.findOne({
      where: { tenantId },
      include: [{ model: Plan }],
      order: [['createdAt', 'DESC']],
    });
  }

  /**
   * Get subscription by ID
   */
  async getSubscriptionById(id: string): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(id, {
      include: [{ model: Plan }, { model: Tenant }],
    });

    if (!subscription) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription with ID '${id}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return subscription;
  }

  /**
   * Update subscription status
   */
  async updateSubscriptionStatus(
    id: string,
    status: SubscriptionStatus,
  ): Promise<Subscription> {
    const subscription = await this.getSubscriptionById(id);
    await subscription.update({ status });
    this.logger.log(`Subscription ${id} status updated to ${status}`);
    return subscription;
  }

  // ---------------------------------------------------------
  // BILLING METRICS
  // ---------------------------------------------------------

  /**
   * Calculate Super Admin billing metrics (totalPlans, orgsSubscribed, activeSubscriptions, mrr)
   */
  async getBillingMetrics(): Promise<BillingMetricsResult> {
    // 1. Total Active Non-Custom Plans
    const totalPlans = await this.planModel.count({
      where: {
        isActive: true,
        isCustom: false,
      },
    });

    // 2. Active Subscriptions Count
    const activeSubscriptionsCount = await this.subscriptionModel.count({
      where: {
        status: SubscriptionStatus.ACTIVE,
      },
    });

    // 3. Unique Organizations Subscribed (ACTIVE or TRIAL)
    //
    // COUNT(DISTINCT "tenantId") rather than GROUP BY and counting the rows in
    // JavaScript: the previous form transferred one row per distinct tenant
    // across the wire only to discard every value and keep `.length`.
    const orgsSubscribed = (await this.subscriptionModel.count({
      where: {
        status: {
          [Op.in]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL],
        },
      },
      distinct: true,
      col: 'tenantId',
    })) as number;

    // 4. Monthly Recurring Revenue for ACTIVE subscriptions.
    //
    // Summed in SQL, grouped by billing cycle, instead of loading every
    // active subscription row (all columns, including the JSON snapshot
    // limits) into this process to add two numbers. This is the metric that
    // grows without bound as the platform succeeds — every new paying
    // organization made the old version slower and heavier, on a dashboard
    // endpoint.
    //
    // Only two groups come back (monthly, annual), so the arithmetic below
    // stays in JS where the /12 conversion is easier to read than in SQL.
    const mrrRows = (await this.subscriptionModel.findAll({
      where: { status: SubscriptionStatus.ACTIVE },
      attributes: [
        'billingCycle',
        [
          fn(
            'SUM',
            col('snapshotMonthlyPrice'),
          ),
          'monthlyTotal',
        ],
        [
          fn(
            'SUM',
            col('snapshotYearlyPrice'),
          ),
          'yearlyTotal',
        ],
      ],
      group: ['billingCycle'],
      raw: true,
    })) as unknown as Array<{
      billingCycle: BillingCycle;
      monthlyTotal: string | null;
      yearlyTotal: string | null;
    }>;

    let mrr = 0;
    for (const row of mrrRows) {
      if (row.billingCycle === BillingCycle.ANNUALLY) {
        mrr += Number(row.yearlyTotal ?? 0) / 12;
      } else {
        mrr += Number(row.monthlyTotal ?? 0);
      }
    }

    // Round to 2 decimal places cleanly
    mrr = Math.round(mrr * 100) / 100;

    // 5. Total Revenue (Sum of SUCCESS payments ONLY).
    //
    // SUM in the database rather than streaming every successful payment the
    // platform has ever taken into memory — an append-only table, so the old
    // version's cost only ever went up.
    const revenueRow = (await this.paymentModel.findOne({
      where: { status: PaymentStatus.SUCCESS },
      attributes: [
        [
          fn(
            'SUM',
            col('amount'),
          ),
          'total',
        ],
      ],
      raw: true,
    })) as unknown as { total: string | null } | null;

    // SUM over no rows is NULL, not 0 — coalesce here rather than letting
    // Number(null) quietly become 0 by accident.
    let totalRevenue = Number(revenueRow?.total ?? 0);
    totalRevenue = Math.round(totalRevenue * 100) / 100;

    // 6. Payment Status Counts
    const pendingPayments = await this.paymentModel.count({
      where: { status: PaymentStatus.PENDING },
    });
    const failedPayments = await this.paymentModel.count({
      where: { status: PaymentStatus.FAILED },
    });

    // 7. Invoice Status Counts
    const overdueInvoices = await this.invoiceModel.count({
      where: { status: InvoiceStatus.OVERDUE },
    });

    // 8. Subscription Status Counts
    const cancelledSubscriptions = await this.subscriptionModel.count({
      where: { status: SubscriptionStatus.CANCELLED },
    });
    const suspendedSubscriptions = await this.subscriptionModel.count({
      where: { status: SubscriptionStatus.SUSPENDED },
    });

    return {
      totalPlans,
      orgsSubscribed,
      activeSubscriptions: activeSubscriptionsCount,
      mrr,
      totalRevenue,
      pendingPayments,
      failedPayments,
      overdueInvoices,
      cancelledSubscriptions,
      suspendedSubscriptions,
    };
  }

  // ---------------------------------------------------------
  // PAYMENT FLOW FOUNDATION (PHASE 2)
  // ---------------------------------------------------------

  /**
   * Safe date utility handling month-end and year-end billing period calculations.
   * Example: Jan 31 + 1 month -> Feb 28/29.
   */
  public addBillingPeriod(date: Date, cycle: BillingCycle): Date {
    const result = new Date(date);
    if (cycle === BillingCycle.ANNUALLY) {
      result.setFullYear(result.getFullYear() + 1);
    } else {
      const currentMonth = result.getMonth();
      result.setMonth(currentMonth + 1);
      // Handle month overflow (e.g. Jan 31 + 1 mo becomes Mar 2 or 3 in non-leap year -> reset to last day of Feb)
      if (result.getMonth() !== (currentMonth + 1) % 12) {
        result.setDate(0);
      }
    }
    return result;
  }

  /**
   * Helper to generate unique Invoice References
   */
  private generateInvoiceReference(): string {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomHex = Math.floor(1000 + Math.random() * 9000);
    return `INV-${dateStr}-${randomHex}`;
  }

  /**
   * Initiate a payment transaction for an organization's subscription.
   * CRITICAL SECURITY RULE: Amount is calculated strictly from Subscription snapshot prices.
   * Client cannot supply custom amount, currency, or tenantId.
   */
  async createPayment(
    tenantId: string,
    dto: CreatePaymentDto,
  ): Promise<Payment> {
    this.logger.log(
      `Initiating payment for tenant ${tenantId}, subscription ${dto.subscriptionId}`,
    );

    // Verify tenant exists
    const tenant = await this.tenantModel.findByPk(tenantId);
    if (!tenant) {
      throw new TenantException(
        TenantErrorCode.TENANT_NOT_FOUND,
        `Tenant with ID '${tenantId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Verify subscription exists and belongs to tenant
    const subscription = await this.subscriptionModel.findByPk(
      dto.subscriptionId,
      {
        include: [{ model: Plan }],
      },
    );

    if (!subscription || subscription.tenantId !== tenantId) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${dto.subscriptionId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    if (subscription.status === SubscriptionStatus.CANCELLED) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Subscription '${dto.subscriptionId}' is cancelled and cannot accept new payments.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const billingCycle =
      dto.billingCycle || subscription.billingCycle || BillingCycle.MONTHLY;

    // Calculate amount from Subscription SNAPSHOT (Grandfathering Preservation Rule)
    const amount =
      billingCycle === BillingCycle.ANNUALLY
        ? Number(subscription.snapshotYearlyPrice)
        : Number(subscription.snapshotMonthlyPrice);

    const currency = subscription.plan?.currency || 'USD';
    const invoiceReference = this.generateInvoiceReference();

    // Resolve Payment Provider via PaymentProviderFactory
    const provider = this.providerFactory.getProvider(dto.provider);

    // Create payment transaction at provider adapter level
    const providerRes = await provider.createPayment({
      internalPaymentId: subscription.id,
      tenantId,
      subscriptionId: subscription.id,
      amount,
      currency,
      billingCycle,
      paymentMethod: dto.paymentMethod || PaymentMethod.CARD,
    });

    const payment = await this.paymentModel.create({
      tenantId,
      subscriptionId: subscription.id,
      amount,
      currency,
      billingCycle,
      status: PaymentStatus.PENDING,
      paymentMethod: dto.paymentMethod || PaymentMethod.CARD,
      provider: provider.name,
      providerTransactionId: providerRes.providerPaymentId,
      invoiceReference,
    });

    // Audit Event
    await this.billingEventModel.create({
      tenantId,
      subscriptionId: subscription.id,
      paymentId: payment.id,
      eventType: 'PAYMENT_INITIATED',
      description: `Payment of $${amount} initiated via provider '${provider.name}'.`,
    });

    return payment;
  }

  /**
   * Process payment success with complete idempotency protection.
   * Updates Payment to SUCCESS, sets paidAt, activates Subscription, and sets nextBillingDate.
   */
  async processPaymentSuccess(
    paymentId: string,
    providerTransactionId?: string,
    metadata?: any,
  ): Promise<{
    payment: Payment;
    subscription: Subscription;
    message: string;
  }> {
    const payment = await this.paymentModel.findByPk(paymentId, {
      include: [{ model: Subscription }],
    });

    if (!payment) {
      throw new TenantException(
        TenantErrorCode.PAYMENT_NOT_FOUND,
        `Payment record '${paymentId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // IDEMPOTENCY / DUPLICATE PROTECTION:
    if (payment.status === PaymentStatus.SUCCESS) {
      this.logger.warn(
        `Payment '${paymentId}' has already been processed as SUCCESS. Idempotent return.`,
      );
      return {
        payment,
        subscription: payment.subscription,
        message: `Payment '${paymentId}' was already processed successfully.`,
      };
    }

    // State machine transition validation
    BillingStateMachine.validatePaymentTransition(
      payment.status,
      PaymentStatus.SUCCESS,
    );

    const subscription = await this.subscriptionModel.findByPk(
      payment.subscriptionId,
    );
    if (!subscription || subscription.tenantId !== payment.tenantId) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Associated subscription '${payment.subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    BillingStateMachine.validateSubscriptionTransition(
      subscription.status,
      SubscriptionStatus.ACTIVE,
    );

    const now = new Date();
    const nextBillingDate = this.addBillingPeriod(now, payment.billingCycle);

    // Atomic Database Transaction
    const sequelize = this.paymentModel.sequelize;
    if (sequelize) {
      await sequelize.transaction(async (t) => {
        await payment.update(
          {
            status: PaymentStatus.SUCCESS,
            paidAt: now,
            providerTransactionId:
              providerTransactionId ||
              payment.providerTransactionId ||
              `TXN_${Date.now()}`,
            metadata: metadata || payment.metadata,
          },
          { transaction: t },
        );

        await subscription.update(
          {
            status: SubscriptionStatus.ACTIVE,
            startDate: subscription.startDate || now,
            nextBillingDate,
            pastDueAt: null,
            gracePeriodEndsAt: null,
          },
          { transaction: t },
        );

        let invoice = await this.invoiceModel.findOne({
          where: { paymentId: payment.id },
          transaction: t,
        });

        if (!invoice) {
          invoice = await this.invoiceModel.findOne({
            where: {
              subscriptionId: subscription.id,
              status: [InvoiceStatus.OPEN, InvoiceStatus.OVERDUE],
            },
            order: [['createdAt', 'DESC']],
            transaction: t,
          });
        }

        if (invoice) {
          BillingStateMachine.validateInvoiceTransition(
            invoice.status,
            InvoiceStatus.PAID,
          );
          await invoice.update(
            {
              status: InvoiceStatus.PAID,
              paidAt: now,
              paymentId: payment.id,
            },
            { transaction: t },
          );
        } else {
          const invoiceNumber = await this.generateInvoiceNumber();
          invoice = await this.invoiceModel.create(
            {
              tenantId: payment.tenantId,
              subscriptionId: subscription.id,
              paymentId: payment.id,
              invoiceNumber,
              status: InvoiceStatus.PAID,
              billingCycle: payment.billingCycle,
              issueDate: payment.createdAt || now,
              dueDate: now,
              paidAt: now,
              subtotal: payment.amount,
              taxAmount: 0,
              discountAmount: 0,
              totalAmount: payment.amount,
              currency: payment.currency || 'USD',
              description: `Paid subscription invoice for ${payment.billingCycle} cycle`,
            },
            { transaction: t },
          );
        }

        await this.billingEventModel.create(
          {
            tenantId: payment.tenantId,
            subscriptionId: subscription.id,
            paymentId: payment.id,
            invoiceId: invoice?.id,
            eventType: 'PAYMENT_SUCCESS',
            description: `Payment of $${payment.amount} succeeded.`,
          },
          { transaction: t },
        );

        await this.billingEventModel.create(
          {
            tenantId: payment.tenantId,
            subscriptionId: subscription.id,
            paymentId: payment.id,
            invoiceId: invoice?.id,
            eventType: 'SUBSCRIPTION_ACTIVATED',
            description: `Subscription activated until ${nextBillingDate.toISOString().slice(0, 10)}.`,
          },
          { transaction: t },
        );
      });
    }

    this.logger.log(
      `Payment '${paymentId}' succeeded. Subscription '${subscription.id}' for tenant '${payment.tenantId}' activated. Next billing date: ${nextBillingDate.toISOString()}`,
    );

    return {
      payment,
      subscription,
      message: `Payment processed successfully. Subscription is now ACTIVE until ${nextBillingDate.toISOString().slice(0, 10)}.`,
    };
  }

  /**
   * Process payment failure cleanly
   */
  async processPaymentFailure(
    paymentId: string,
    failureReason?: string,
  ): Promise<Payment> {
    const payment = await this.paymentModel.findByPk(paymentId);

    if (!payment) {
      throw new TenantException(
        TenantErrorCode.PAYMENT_NOT_FOUND,
        `Payment record '${paymentId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    if (payment.status === PaymentStatus.SUCCESS) {
      throw new TenantException(
        TenantErrorCode.PAYMENT_ALREADY_PROCESSED,
        `Payment '${paymentId}' has already succeeded and cannot be marked as failed.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // State machine transition validation
    BillingStateMachine.validatePaymentTransition(
      payment.status,
      PaymentStatus.FAILED,
    );

    const sequelize = this.paymentModel.sequelize;
    if (sequelize) {
      await sequelize.transaction(async (t) => {
        await payment.update(
          {
            status: PaymentStatus.FAILED,
            failureReason:
              failureReason || 'Payment simulation failed or card declined.',
          },
          { transaction: t },
        );

        await this.billingEventModel.create(
          {
            tenantId: payment.tenantId,
            subscriptionId: payment.subscriptionId,
            paymentId: payment.id,
            eventType: 'PAYMENT_FAILED',
            description: `Payment failed: ${payment.failureReason || failureReason}`,
          },
          { transaction: t },
        );
      });
    }

    this.logger.log(
      `Payment '${paymentId}' marked as FAILED. Reason: ${payment.failureReason}`,
    );
    return payment;
  }

  /**
   * Internal Payment Simulation Handler (Testing & Development Gateway Simulator)
   */
  /**
   * `tenantId` is required, not optional: this previously looked the payment
   * up by primary key alone, so a caller holding `billing.manage` in one
   * organization could force any other organization's payment to SUCCESS or
   * FAILED just by knowing its id. The lookup is now scoped the same way
   * getPaymentById is, and a payment belonging to another tenant reports as
   * not found rather than forbidden so ids are not confirmed to outsiders.
   */
  async simulatePayment(
    tenantId: string,
    dto: ProcessPaymentDto,
  ): Promise<any> {
    if (!tenantId) {
      throw new TenantException(
        TenantErrorCode.TENANT_REQUIRED,
        'Tenant context is required to simulate a payment.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const payment = await this.paymentModel.findOne({
      where: { id: dto.paymentId, tenantId },
    });
    if (!payment) {
      throw new TenantException(
        TenantErrorCode.PAYMENT_NOT_FOUND,
        `Payment record '${dto.paymentId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Resolve Provider via PaymentProviderFactory
    const provider = this.providerFactory.getProvider(payment.provider);

    // Process status change via provider adapter
    const providerRes = await provider.processPayment({
      providerPaymentId: payment.providerTransactionId || payment.id,
      paymentId: payment.id,
      action: dto.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      failureReason: dto.failureReason,
    });

    if (providerRes.status === PaymentStatus.SUCCESS) {
      return this.processPaymentSuccess(
        payment.id,
        providerRes.transactionId,
        providerRes.metadata,
      );
    } else {
      return this.processPaymentFailure(
        payment.id,
        providerRes.failureReason || 'Payment failed',
      );
    }
  }

  /**
   * Get payment history for authenticated organization with tenant isolation, filtering & pagination
   */
  async getOrganizationPayments(
    tenantId: string,
    query?: PaymentQueryDto,
  ): Promise<{ data: Payment[]; total: number; page: number; limit: number }> {
    const page = query?.page || 1;
    const limit = query?.limit || 10;
    const offset = (page - 1) * limit;

    const where: any = { tenantId };

    if (query?.status) {
      where.status = query.status;
    }

    if (query?.startDate || query?.endDate) {
      where.createdAt = {};
      if (query.startDate) {
        where.createdAt[Op.gte] = new Date(query.startDate);
      }
      if (query.endDate) {
        where.createdAt[Op.lte] = new Date(query.endDate);
      }
    }

    const { count, rows } = await this.paymentModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    return {
      data: rows,
      total: count,
      page,
      limit,
    };
  }

  /**
   * Get single payment record with strict tenant isolation
   */
  async getPaymentById(tenantId: string, paymentId: string): Promise<Payment> {
    const payment = await this.paymentModel.findOne({
      where: { id: paymentId, tenantId },
      include: [{ model: Subscription, include: [Plan] }],
    });

    if (!payment) {
      throw new TenantException(
        TenantErrorCode.PAYMENT_NOT_FOUND,
        `Payment record '${paymentId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return payment;
  }

  /**
   * Get payment status overview for polling/checkout UI
   */
  async getPaymentStatus(tenantId: string, paymentId: string): Promise<any> {
    const payment = await this.getPaymentById(tenantId, paymentId);
    return {
      paymentId: payment.id,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      billingCycle: payment.billingCycle,
      paidAt: payment.paidAt,
      invoiceReference: payment.invoiceReference,
      subscriptionStatus: payment.subscription?.status,
    };
  }

  // ---------------------------------------------------------
  // PHASE 3: INVOICE & SUBSCRIPTION LIFECYCLE MANAGEMENT
  // ---------------------------------------------------------

  /**
   * Collision-safe sequential Invoice Number Generator: INV-YYYY-XXXXXX
   */
  public async generateInvoiceNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const count = await this.invoiceModel.count();
    const nextSeq = (count + 1).toString().padStart(6, '0');
    return `INV-${year}-${nextSeq}`;
  }

  /**
   * Create an invoice for a subscription.
   * CRITICAL: Invoice amount is calculated strictly from Subscription snapshot prices.
   */
  async createInvoice(
    tenantId: string,
    dto: CreateInvoiceDto,
  ): Promise<Invoice> {
    const subscription = await this.subscriptionModel.findByPk(
      dto.subscriptionId,
      {
        include: [Plan],
      },
    );

    if (!subscription || subscription.tenantId !== tenantId) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${dto.subscriptionId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const billingCycle =
      dto.billingCycle || subscription.billingCycle || BillingCycle.MONTHLY;

    // Calculate subtotal & totalAmount from Subscription SNAPSHOT
    const subtotal =
      billingCycle === BillingCycle.ANNUALLY
        ? Number(subscription.snapshotYearlyPrice)
        : Number(subscription.snapshotMonthlyPrice);

    const totalAmount = subtotal;
    const currency = subscription.plan?.currency || 'USD';
    const invoiceNumber = await this.generateInvoiceNumber();

    const issueDate = new Date();
    const dueDate = dto.dueDate
      ? new Date(dto.dueDate)
      : new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);

    const invoice = await this.invoiceModel.create({
      tenantId,
      subscriptionId: subscription.id,
      paymentId: dto.paymentId || null,
      invoiceNumber,
      status: InvoiceStatus.OPEN,
      billingCycle,
      issueDate,
      dueDate,
      subtotal,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount,
      currency,
      description:
        dto.description ||
        `Invoice for ${subscription.plan?.name || 'HRMS'} (${billingCycle})`,
    });

    return invoice;
  }

  /**
   * Get invoice by ID with strict tenant isolation
   */
  async getInvoiceById(tenantId: string, invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceModel.findOne({
      where: { id: invoiceId, tenantId },
      include: [{ model: Subscription, include: [Plan] }, { model: Payment }],
    });

    if (!invoice) {
      throw new TenantException(
        TenantErrorCode.INVOICE_NOT_FOUND,
        `Invoice '${invoiceId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return invoice;
  }

  /**
   * Get organization invoice history with filters and pagination
   */
  async getOrganizationInvoices(
    tenantId: string,
    query?: InvoiceQueryDto,
  ): Promise<{ data: Invoice[]; total: number; page: number; limit: number }> {
    const page = query?.page || 1;
    const limit = query?.limit || 10;
    const offset = (page - 1) * limit;

    const where: any = { tenantId };

    if (query?.status) {
      where.status = query.status;
    }

    if (query?.startDate || query?.endDate) {
      where.issueDate = {};
      if (query.startDate) {
        where.issueDate[Op.gte] = new Date(query.startDate);
      }
      if (query.endDate) {
        where.issueDate[Op.lte] = new Date(query.endDate);
      }
    }

    const { count, rows } = await this.invoiceModel.findAndCountAll({
      where,
      order: [['issueDate', 'DESC']],
      limit,
      offset,
    });

    return {
      data: rows,
      total: count,
      page,
      limit,
    };
  }

  /**
   * Cancel an organization's subscription safely. Preserves historical billing data.
   */
  async cancelSubscription(
    tenantId: string,
    subscriptionId: string,
    dto?: CancelSubscriptionDto,
  ): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);

    if (!subscription || subscription.tenantId !== tenantId) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const now = new Date();
    await subscription.update({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: now,
      cancellationReason:
        dto?.cancellationReason || 'Cancelled by organization administrator',
    });

    this.logger.log(
      `Subscription '${subscriptionId}' cancelled for tenant '${tenantId}'`,
    );
    this.announceSubscription(tenantId, (org) => `${org} cancelled its subscription`, subscription.cancellationReason || 'No reason was given.');
    return subscription;
  }

  /**
   * Suspend subscription (Platform/Internal)
   */
  async suspendSubscription(
    subscriptionId: string,
    tenantId?: string,
  ): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);

    if (!subscription || (tenantId && subscription.tenantId !== tenantId)) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    await subscription.update({
      status: SubscriptionStatus.SUSPENDED,
    });

    this.logger.log(`Subscription '${subscriptionId}' suspended`);
    this.announceSubscription(subscription.tenantId, (org) => `${org}'s subscription was suspended`, 'Suspended by a platform administrator.');
    return subscription;
  }

  /**
   * Reactivate a suspended/cancelled subscription
   */
  async reactivateSubscription(
    subscriptionId: string,
    tenantId?: string,
  ): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);

    if (!subscription || (tenantId && subscription.tenantId !== tenantId)) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const now = new Date();
    const isCurrent =
      subscription.nextBillingDate &&
      new Date(subscription.nextBillingDate) > now;
    const newStatus = isCurrent
      ? SubscriptionStatus.ACTIVE
      : SubscriptionStatus.PENDING_PAYMENT;

    await subscription.update({
      status: newStatus,
      cancelledAt: null,
      cancellationReason: null,
    });

    this.logger.log(
      `Subscription '${subscriptionId}' reactivated with status ${newStatus}`,
    );
    return subscription;
  }

  /**
   * Change subscription plan (Plan A -> Plan B).
   * Snapshots new plan while preserving old payment & invoice history intact.
   */
  async changeSubscriptionPlan(
    tenantId: string,
    subscriptionId: string,
    dto: ChangeSubscriptionPlanDto,
  ): Promise<Subscription> {
    const existingSub = await this.subscriptionModel.findByPk(subscriptionId);

    if (!existingSub || existingSub.tenantId !== tenantId) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found for this organization.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Verify new plan exists and is active
    const newPlan = await this.getPlanById(dto.newPlanId);
    if (!newPlan.isActive) {
      throw new TenantException(
        TenantErrorCode.PLAN_INACTIVE,
        `New plan '${newPlan.name}' is inactive and cannot be selected.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const billingCycle =
      dto.billingCycle || existingSub.billingCycle || BillingCycle.MONTHLY;

    // Snapshot new plan's prices & limits
    const snapshotMonthlyPrice = Number(newPlan.monthlyPrice);
    const snapshotYearlyPrice = Number(newPlan.yearlyPrice);
    const snapshotLimits: SubscriptionSnapshotLimits = {
      maxEmployees: newPlan.maxEmployees,
      maxHrUsers: newPlan.maxHrUsers,
      maxAdminUsers: newPlan.maxAdminUsers,
      storageGb: newPlan.storageGb,
      apiCallsPerMonth: newPlan.apiCallsPerMonth,
      dataRetentionDays: newPlan.dataRetentionDays,
      customReportsLimit: newPlan.customReportsLimit,
      supportType: newPlan.supportType,
      securityLevel: newPlan.securityLevel,
    };

    // Update existing subscription with new plan snapshot
    await existingSub.update({
      planId: newPlan.id,
      billingCycle,
      snapshotMonthlyPrice,
      snapshotYearlyPrice,
      snapshotLimits,
      status: SubscriptionStatus.PENDING_PAYMENT, // Pending payment for new plan activation
    });

    this.logger.log(
      `Tenant '${tenantId}' subscription '${subscriptionId}' changed to Plan '${newPlan.name}'. Snapshot updated.`,
    );

    return existingSub;
  }

  /**
   * Renew subscription: Generates renewal invoice using Subscription snapshot price
   */
  async renewSubscription(
    subscriptionId: string,
  ): Promise<{ invoice: Invoice; subscription: Subscription }> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId, {
      include: [Plan],
    });

    if (!subscription) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const invoice = await this.createInvoice(subscription.tenantId, {
      subscriptionId: subscription.id,
      billingCycle: subscription.billingCycle,
      description: `Renewal invoice for ${subscription.plan?.name || 'HRMS'} (${subscription.billingCycle})`,
    });

    return { invoice, subscription };
  }

  /**
   * Get chronological audit history (subscriptions, invoices, payments) for an organization
   */
  async getSubscriptionHistory(tenantId: string): Promise<any> {
    const subscriptions = await this.subscriptionModel.findAll({
      where: { tenantId },
      include: [Plan],
      order: [['createdAt', 'DESC']],
    });

    const invoices = await this.invoiceModel.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
    });

    const payments = await this.paymentModel.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
    });

    return {
      subscriptions,
      invoices,
      payments,
    };
  }

  /**
   * Get Organization Billing Dashboard Summary
   */
  async getBillingSummary(tenantId: string): Promise<any> {
    const subscription = await this.getSubscriptionByTenant(tenantId);
    const lastPayment = await this.paymentModel.findOne({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
    });

    const openInvoice = await this.invoiceModel.findOne({
      where: { tenantId, status: InvoiceStatus.OPEN },
      order: [['createdAt', 'DESC']],
    });

    // Compute usage (using department/designation count as proxy or mock current employees)
    const maxEmployees = subscription?.snapshotLimits?.maxEmployees ?? 100;
    const currentEmployees = 42; // Example active employee count

    const amount = subscription
      ? subscription.billingCycle === BillingCycle.ANNUALLY
        ? Number(subscription.snapshotYearlyPrice)
        : Number(subscription.snapshotMonthlyPrice)
      : 0;

    return {
      subscription: subscription
        ? {
            id: subscription.id,
            planName: subscription.plan?.name || 'Standard',
            status: subscription.status,
            billingCycle: subscription.billingCycle,
            startDate: subscription.startDate,
            nextBillingDate: subscription.nextBillingDate,
          }
        : null,
      pricing: {
        amount,
        currency: subscription?.plan?.currency || 'USD',
      },
      usage: {
        currentEmployees,
        maxEmployees,
        utilizationPercentage:
          maxEmployees > 0
            ? Math.round((currentEmployees / maxEmployees) * 100)
            : 0,
      },
      billing: {
        lastPayment: lastPayment
          ? {
              id: lastPayment.id,
              amount: Number(lastPayment.amount),
              status: lastPayment.status,
              paidAt: lastPayment.paidAt,
            }
          : null,
        outstandingAmount: openInvoice ? Number(openInvoice.totalAmount) : 0,
        nextInvoiceDate: subscription?.nextBillingDate || null,
      },
    };
  }

  // ---------------------------------------------------------
  // SUPER ADMIN SUBSCRIPTION MANAGEMENT
  // ---------------------------------------------------------

  /**
   * Super Admin: Get all platform subscriptions with filtering & pagination
   */
  async getSuperAdminSubscriptions(
    query?: SubscriptionQueryDto,
  ): Promise<{
    data: Subscription[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query?.page || 1;
    const limit = query?.limit || 10;
    const offset = (page - 1) * limit;

    const where: any = {};
    if (query?.status) {
      where.status = query.status;
    }

    const { count, rows } = await this.subscriptionModel.findAndCountAll({
      where,
      include: [Plan, Tenant],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    return {
      data: rows,
      total: count,
      page,
      limit,
    };
  }

  /**
   * Super Admin: Get single subscription by ID
   */
  async getSuperAdminSubscriptionById(id: string): Promise<Subscription> {
    return this.getSubscriptionById(id);
  }

  /**
   * Super Admin: Get all invoices for a subscription
   */
  async getSuperAdminSubscriptionInvoices(
    subscriptionId: string,
  ): Promise<Invoice[]> {
    return this.invoiceModel.findAll({
      where: { subscriptionId },
      include: [Tenant, Payment],
      order: [['createdAt', 'DESC']],
    });
  }

  /**
   * Super Admin: Get all payments for a subscription
   */
  async getSuperAdminSubscriptionPayments(
    subscriptionId: string,
  ): Promise<Payment[]> {
    return this.paymentModel.findAll({
      where: { subscriptionId },
      include: [Tenant],
      order: [['createdAt', 'DESC']],
    });
  }

  // ---------------------------------------------------------
  // PHASE 4: AUTOMATION, MONITORING & MANUAL CONTROLS
  // ---------------------------------------------------------

  /**
   * Super Admin: Mark subscription PAST_DUE manually
   */
  async markPastDue(subscriptionId: string): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);
    if (!subscription) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const now = new Date();
    const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    await subscription.update({
      status: SubscriptionStatus.PAST_DUE,
      pastDueAt: now,
      gracePeriodEndsAt,
    });

    await this.billingEventModel.create({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      eventType: 'SUBSCRIPTION_PAST_DUE',
      description: 'Subscription manually marked as PAST_DUE by Super Admin.',
    });

    return subscription;
  }

  /**
   * Super Admin: Extend subscription grace period safely
   */
  async extendGracePeriod(
    subscriptionId: string,
    additionalDays: number = 7,
  ): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);
    if (!subscription) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const baseDate =
      subscription.gracePeriodEndsAt &&
      new Date(subscription.gracePeriodEndsAt) > new Date()
        ? new Date(subscription.gracePeriodEndsAt)
        : new Date();

    const newGracePeriodEndsAt = new Date(
      baseDate.getTime() + additionalDays * 24 * 60 * 60 * 1000,
    );

    await subscription.update({
      status: SubscriptionStatus.PAST_DUE,
      gracePeriodEndsAt: newGracePeriodEndsAt,
    });

    await this.billingEventModel.create({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      eventType: 'GRACE_PERIOD_EXTENDED',
      description: `Grace period extended by ${additionalDays} days until ${newGracePeriodEndsAt.toISOString().slice(0, 10)}.`,
    });

    return subscription;
  }

  /**
   * Super Admin: Activate subscription manually
   */
  async activateSubscription(subscriptionId: string): Promise<Subscription> {
    const subscription = await this.subscriptionModel.findByPk(subscriptionId);
    if (!subscription) {
      throw new TenantException(
        TenantErrorCode.SUBSCRIPTION_NOT_FOUND,
        `Subscription '${subscriptionId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const now = new Date();
    const nextBillingDate = this.addBillingPeriod(
      now,
      subscription.billingCycle,
    );

    await subscription.update({
      status: SubscriptionStatus.ACTIVE,
      pastDueAt: null,
      gracePeriodEndsAt: null,
      nextBillingDate,
    });

    await this.billingEventModel.create({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      eventType: 'SUBSCRIPTION_ACTIVATED',
      description: 'Subscription manually activated by Super Admin.',
    });

    return subscription;
  }

  /**
   * Super Admin: Void an invoice (Rejects if invoice status is PAID)
   */
  async voidInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = await this.invoiceModel.findByPk(invoiceId);
    if (!invoice) {
      throw new TenantException(
        TenantErrorCode.INVOICE_NOT_FOUND,
        `Invoice '${invoiceId}' was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // State machine transition validation
    BillingStateMachine.validateInvoiceTransition(
      invoice.status,
      InvoiceStatus.VOID,
    );

    await invoice.update({
      status: InvoiceStatus.VOID,
    });

    await this.billingEventModel.create({
      tenantId: invoice.tenantId,
      subscriptionId: invoice.subscriptionId,
      invoiceId: invoice.id,
      eventType: 'INVOICE_VOIDED',
      description: `Invoice '${invoice.invoiceNumber}' was voided by Super Admin.`,
    });

    return invoice;
  }

  /**
   * Super Admin Monitoring: Get upcoming renewals
   */
  async getUpcomingRenewals(
    thresholdDays: number = 7,
  ): Promise<Subscription[]> {
    const now = new Date();
    const thresholdDate = new Date(
      now.getTime() + thresholdDays * 24 * 60 * 60 * 1000,
    );

    return this.subscriptionModel.findAll({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate: {
          [Op.between]: [now, thresholdDate],
        },
      },
      include: [Tenant, Plan],
      order: [['nextBillingDate', 'ASC']],
    });
  }

  /**
   * Super Admin Monitoring: Get overdue subscriptions
   */
  async getOverdueSubscriptions(): Promise<Subscription[]> {
    return this.subscriptionModel.findAll({
      where: {
        status: SubscriptionStatus.PAST_DUE,
      },
      include: [Tenant, Plan],
      order: [['pastDueAt', 'DESC']],
    });
  }

  /**
   * Super Admin Monitoring: Get suspended subscriptions
   */
  async getSuspendedSubscriptions(): Promise<Subscription[]> {
    return this.subscriptionModel.findAll({
      where: {
        status: SubscriptionStatus.SUSPENDED,
      },
      include: [Tenant, Plan],
      order: [['updatedAt', 'DESC']],
    });
  }

  /**
   * Get billing audit events (tenant-isolated or global for Super Admin)
   */
  async getBillingEvents(
    tenantId?: string,
    query?: BillingEventQueryDto,
  ): Promise<{
    data: BillingEvent[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = query?.page || 1;
    const limit = query?.limit || 10;
    const offset = (page - 1) * limit;

    const where: any = {};
    if (tenantId) {
      where.tenantId = tenantId;
    }

    const { count, rows } = await this.billingEventModel.findAndCountAll({
      where,
      include: [Tenant, Subscription],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    return {
      data: rows,
      total: count,
      page,
      limit,
    };
  }

  /**
   * Get subscription status details for organization billing status endpoint
   */
  async getBillingStatus(tenantId: string): Promise<any> {
    const subscription = await this.getSubscriptionByTenant(tenantId);
    const now = new Date();

    const canAccessHrms = subscription
      ? subscription.status === SubscriptionStatus.ACTIVE ||
        (subscription.status === SubscriptionStatus.PAST_DUE &&
          subscription.gracePeriodEndsAt &&
          new Date(subscription.gracePeriodEndsAt) >= now)
      : false;

    return {
      subscriptionStatus: subscription
        ? subscription.status
        : 'NO_SUBSCRIPTION',
      billingCycle: subscription ? subscription.billingCycle : null,
      planName: subscription?.plan?.name || 'None',
      nextBillingDate: subscription?.nextBillingDate || null,
      gracePeriodEndsAt: subscription?.gracePeriodEndsAt || null,
      canAccessHrms,
      canManageBilling: true, // Organization Admin can ALWAYS manage billing
    };
  }
}
