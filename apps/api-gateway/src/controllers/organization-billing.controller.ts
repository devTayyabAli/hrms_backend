import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Inject,
  UseGuards,
  Req,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  CreatePaymentDto,
  ProcessPaymentDto,
  PaymentQueryDto,
  CreateInvoiceDto,
  InvoiceQueryDto,
  CancelSubscriptionDto,
  ChangeSubscriptionPlanDto,
} from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  RequirePermissions,
} from '@app/tenant-context';

@Controller('organization/billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard)
export class OrganizationBillingController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  /**
   * Resolve the authenticated user's tenant ID from their JWT only.
   * Never falls back to a client-supplied header — an authenticated user's
   * billing/subscription/payment data must always be scoped to the tenant
   * their token actually belongs to, not one they merely claim via header.
   * SuperAdmin cross-tenant billing operations have their own dedicated
   * endpoints under /superadmin/billing/*, so no header-based override is
   * needed here.
   */
  private resolveTenantId(req: any): string {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException(
        'Tenant context required: your account is not associated with an organization.',
      );
    }
    return tenantId;
  }

  // ==========================================
  // SUBSCRIPTION MANAGEMENT
  // ==========================================

  @ApiTags(TAGS.ORG_BILLING)
  @Get('subscription')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary: 'Get current organization subscription details & snapshot limits',
  })
  getSubscription(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_SUBSCRIPTION, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('subscription/history')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Get chronological subscription, payment, and invoice audit timeline',
  })
  getSubscriptionHistory(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_HISTORY,
      { tenantId },
    );
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Post('subscription/cancel')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary:
      'Cancel current organization subscription (Preserves historical audit data)',
  })
  cancelSubscription(@Req() req: any, @Body() dto: CancelSubscriptionDto) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_CANCEL,
      {
        tenantId,
        subscriptionId: req.body?.subscriptionId, // or derived from subscription
        dto,
      },
    );
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Post('subscription/reactivate')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary: 'Reactivate cancelled or suspended organization subscription',
  })
  reactivateSubscription(
    @Req() req: any,
    @Body() body: { subscriptionId: string },
  ) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_REACTIVATE,
      {
        tenantId,
        subscriptionId: body.subscriptionId,
      },
    );
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Post('subscription/change-plan')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary:
      'Change subscription plan (Snapshots new plan while preserving old history)',
  })
  changeSubscriptionPlan(
    @Req() req: any,
    @Body() dto: ChangeSubscriptionPlanDto,
  ) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(
      MESSAGE_PATTERNS.BILLING.SUBSCRIPTION_CHANGE_PLAN,
      {
        tenantId,
        subscriptionId: req.body?.subscriptionId,
        dto,
      },
    );
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('plan')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary: 'Get details of the current plan subscribed by the organization',
  })
  getPlan(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_SUBSCRIPTION, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('billing-summary')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Get Organization Billing Dashboard summary (Subscription, Pricing, Usage vs Limits, Last Payment)',
  })
  getBillingSummary(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_SUMMARY, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('status')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Get organization subscription status & HRMS access entitlement (canAccessHrms, canManageBilling)',
  })
  getStatus(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_STATUS, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('upcoming')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({ summary: 'Get organization upcoming renewal details' })
  getUpcoming(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_SUMMARY, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('usage')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Get detailed organization usage vs snapshot plan limits (employees, HR users, admin users, storage)',
  })
  getUsage(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_USAGE, {
      tenantId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('events')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({ summary: 'Get organization billing audit events' })
  getEvents(@Req() req: any, @Query() query: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_EVENTS, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('limits')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({ summary: 'Get organization snapshot limit overview' })
  getLimits(@Req() req: any) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.BILLING_USAGE, {
      tenantId,
    });
  }

  // ==========================================
  // INVOICE APIS
  // ==========================================

  @ApiTags(TAGS.ORG_BILLING)
  @Get('invoices')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({ summary: 'Get organization invoice history' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getInvoices(@Req() req: any, @Query() query: InvoiceQueryDto) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.INVOICE_LIST, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('invoices/:id')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary: 'Get single invoice details (Strict tenant isolation)',
  })
  getInvoiceById(@Req() req: any, @Param('id') invoiceId: string) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.INVOICE_GET, {
      tenantId,
      invoiceId,
    });
  }

  // ==========================================
  // PAYMENT FLOW ENDPOINTS
  // ==========================================

  @ApiTags(TAGS.ORG_BILLING)
  @Post('payments')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary: 'Initiate a new payment transaction for organization subscription',
  })
  createPayment(@Req() req: any, @Body() dto: CreatePaymentDto) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.CREATE_PAYMENT, {
      tenantId,
      dto,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('payments')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({ summary: 'Get organization payment transaction history' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  getPayments(@Req() req: any, @Query() query: PaymentQueryDto) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_PAYMENTS, {
      tenantId,
      query,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('payments/:id')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Get details for a single payment transaction (Strict tenant isolation)',
  })
  getPaymentById(@Req() req: any, @Param('id') paymentId: string) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_PAYMENT_BY_ID, {
      tenantId,
      paymentId,
    });
  }

  @ApiTags(TAGS.ORG_BILLING)
  @Get('payments/:id/status')
  @RequirePermissions('billing.view', 'billing.manage')
  @ApiOperation({
    summary:
      'Poll status of a payment transaction (For frontend checkout page)',
  })
  getPaymentStatus(@Req() req: any, @Param('id') paymentId: string) {
    const tenantId = this.resolveTenantId(req);
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.GET_PAYMENT_STATUS, {
      tenantId,
      paymentId,
    });
  }

  /**
   * Gateway-testing hook that forces a payment to SUCCESS or FAILED without
   * a real provider round-trip.
   *
   * Refused outside development. It mutates billing state — marking invoices
   * paid, reactivating subscriptions — so leaving it reachable in production
   * would let any `billing.manage` holder settle their own invoices for free.
   * `NODE_ENV` is read per request rather than cached at construction so a
   * process started without it set cannot be flipped open later.
   */
  @ApiTags(TAGS.ORG_BILLING)
  @Post('payments/:id/simulate')
  @RequirePermissions('billing.manage')
  @ApiOperation({
    summary:
      'Simulate payment success or failure (development only — returns 404 when NODE_ENV is not "development")',
  })
  simulatePayment(
    @Req() req: any,
    @Param('id') paymentId: string,
    @Body() dto: ProcessPaymentDto,
  ) {
    if (process.env.NODE_ENV !== 'development') {
      // NotFound rather than Forbidden: a disabled test hook should be
      // indistinguishable from a route that does not exist.
      throw new NotFoundException('Cannot POST to this route.');
    }

    const tenantId = this.resolveTenantId(req);
    dto.paymentId = paymentId;
    return this.tenantClient.send(MESSAGE_PATTERNS.BILLING.SIMULATE_PAYMENT, {
      tenantId,
      dto,
    });
  }
}
