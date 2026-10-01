import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsUUID,
  ValidateNested,
  IsDefined,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export enum SupportType {
  BASIC = 'BASIC',
  EMAIL = 'EMAIL',
  EMAIL_CHAT = 'EMAIL_CHAT',
  PRIORITY = 'PRIORITY',
}

export enum SecurityLevel {
  BASIC = 'BASIC',
  STANDARD = 'STANDARD',
  SSO = 'SSO',
  ADVANCED = 'ADVANCED',
}

export enum SubscriptionStatus {
  TRIAL = 'TRIAL',
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  ACTIVE = 'ACTIVE',
  PAST_DUE = 'PAST_DUE',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
}

export enum BillingCycle {
  MONTHLY = 'MONTHLY',
  ANNUALLY = 'ANNUALLY',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  OPEN = 'OPEN',
  PAID = 'PAID',
  VOID = 'VOID',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentMethod {
  CARD = 'CARD',
  BANK_TRANSFER = 'BANK_TRANSFER',
  WALLET = 'WALLET',
  MANUAL = 'MANUAL',
  OTHER = 'OTHER',
}

export class CreatePlanDto {
  @ApiProperty({ example: 'Professional Plan' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'Full featured plan for growing teams',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 299.0 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  monthlyPrice: number;

  @ApiProperty({ example: 2990.0 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  yearlyPrice: number;

  @ApiProperty({ example: 'USD', required: false, default: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string = 'USD';

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(-1)
  @IsNotEmpty()
  maxEmployees: number;

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(-1)
  @IsNotEmpty()
  maxHrUsers: number;

  @ApiProperty({ example: 5 })
  @IsNumber()
  @Min(-1)
  @IsNotEmpty()
  maxAdminUsers: number;

  @ApiProperty({ example: 100 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  storageGb: number;

  @ApiProperty({ example: 100000 })
  @IsNumber()
  @Min(-1)
  @IsNotEmpty()
  apiCallsPerMonth: number;

  @ApiProperty({ example: 365 })
  @IsNumber()
  @Min(0)
  @IsNotEmpty()
  dataRetentionDays: number;

  @ApiProperty({ example: 50 })
  @IsNumber()
  @Min(-1)
  @IsNotEmpty()
  customReportsLimit: number;

  @ApiProperty({ enum: SupportType, example: SupportType.PRIORITY })
  @IsEnum(SupportType)
  @IsNotEmpty()
  supportType: SupportType;

  @ApiProperty({ enum: SecurityLevel, example: SecurityLevel.STANDARD })
  @IsEnum(SecurityLevel)
  @IsNotEmpty()
  securityLevel: SecurityLevel;

  @ApiProperty({ example: false, required: false, default: false })
  @IsBoolean()
  @IsOptional()
  hasDedicatedAccountManager?: boolean = false;

  @ApiProperty({ example: false, required: false, default: false })
  @IsBoolean()
  @IsOptional()
  isCustom?: boolean = false;

  @ApiProperty({ example: true, required: false, default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;
}

export class UpdatePlanDto {
  @ApiProperty({ example: 'Professional Plan Plus', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'Updated description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 349.0, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  monthlyPrice?: number;

  @ApiProperty({ example: 3490.0, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  yearlyPrice?: number;

  @ApiProperty({ example: 'USD', required: false })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiProperty({ example: 600, required: false })
  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxEmployees?: number;

  @ApiProperty({ example: 25, required: false })
  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxHrUsers?: number;

  @ApiProperty({ example: 10, required: false })
  @IsNumber()
  @Min(-1)
  @IsOptional()
  maxAdminUsers?: number;

  @ApiProperty({ example: 150, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  storageGb?: number;

  @ApiProperty({ example: 150000, required: false })
  @IsNumber()
  @Min(-1)
  @IsOptional()
  apiCallsPerMonth?: number;

  @ApiProperty({ example: 730, required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  dataRetentionDays?: number;

  @ApiProperty({ example: 100, required: false })
  @IsNumber()
  @Min(-1)
  @IsOptional()
  customReportsLimit?: number;

  @ApiProperty({ enum: SupportType, required: false })
  @IsEnum(SupportType)
  @IsOptional()
  supportType?: SupportType;

  @ApiProperty({ enum: SecurityLevel, required: false })
  @IsEnum(SecurityLevel)
  @IsOptional()
  securityLevel?: SecurityLevel;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  hasDedicatedAccountManager?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  isCustom?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateSubscriptionDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  planId: string;

  @ApiProperty({
    enum: BillingCycle,
    example: BillingCycle.MONTHLY,
    required: false,
    default: BillingCycle.MONTHLY,
  })
  @IsEnum(BillingCycle)
  @IsOptional()
  billingCycle?: BillingCycle = BillingCycle.MONTHLY;

  @ApiProperty({
    enum: SubscriptionStatus,
    example: SubscriptionStatus.PENDING_PAYMENT,
    required: false,
    default: SubscriptionStatus.PENDING_PAYMENT,
  })
  @IsEnum(SubscriptionStatus)
  @IsOptional()
  status?: SubscriptionStatus = SubscriptionStatus.PENDING_PAYMENT;
}

export class UpdateSubscriptionStatusDto {
  @ApiProperty({ enum: SubscriptionStatus, example: SubscriptionStatus.ACTIVE })
  @IsEnum(SubscriptionStatus)
  @IsNotEmpty()
  status: SubscriptionStatus;
}

export class PlanFilterDto {
  @ApiProperty({ example: true, required: false })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isActive?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  isCustom?: boolean;
}

export class CreatePaymentDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  subscriptionId: string;

  @ApiProperty({
    enum: BillingCycle,
    example: BillingCycle.MONTHLY,
    required: false,
  })
  @IsEnum(BillingCycle)
  @IsOptional()
  billingCycle?: BillingCycle;

  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.CARD,
    required: false,
    default: PaymentMethod.CARD,
  })
  @IsEnum(PaymentMethod)
  @IsOptional()
  paymentMethod?: PaymentMethod = PaymentMethod.CARD;

  @ApiProperty({ example: 'internal', required: false, default: 'internal' })
  @IsString()
  @IsOptional()
  provider?: string = 'internal';
}

export class ProcessPaymentDto {
  @ApiProperty({ example: 'f6b12f6a-04b3-4f8a-9892-9653d9e29999' })
  @IsUUID()
  @IsNotEmpty()
  paymentId: string;

  @ApiProperty({ example: 'SUCCESS', enum: ['SUCCESS', 'FAILED'] })
  @IsString()
  @IsNotEmpty()
  result: 'SUCCESS' | 'FAILED';

  @ApiProperty({ example: 'Card declined by issuing bank', required: false })
  @IsString()
  @IsOptional()
  failureReason?: string;
}

export class PaymentQueryDto {
  @ApiProperty({ enum: PaymentStatus, required: false })
  @IsEnum(PaymentStatus)
  @IsOptional()
  status?: PaymentStatus;

  @ApiProperty({ example: '2026-01-01', required: false })
  @IsString()
  @IsOptional()
  startDate?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsString()
  @IsOptional()
  endDate?: string;

  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1))
  page?: number = 1;

  @ApiProperty({ example: 10, required: false, default: 10 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 10))
  limit?: number = 10;
}

export class CreateInvoiceDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  subscriptionId: string;

  @ApiProperty({
    example: 'f6b12f6a-04b3-4f8a-9892-9653d9e29999',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  paymentId?: string;

  @ApiProperty({ enum: BillingCycle, required: false })
  @IsEnum(BillingCycle)
  @IsOptional()
  billingCycle?: BillingCycle;

  @ApiProperty({
    example: 'Monthly HRMS Platform Subscription Invoice',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: '2026-02-15', required: false })
  @IsString()
  @IsOptional()
  dueDate?: string;
}

export class InvoiceQueryDto {
  @ApiProperty({ enum: InvoiceStatus, required: false })
  @IsEnum(InvoiceStatus)
  @IsOptional()
  status?: InvoiceStatus;

  @ApiProperty({ example: '2026-01-01', required: false })
  @IsString()
  @IsOptional()
  startDate?: string;

  @ApiProperty({ example: '2026-12-31', required: false })
  @IsString()
  @IsOptional()
  endDate?: string;

  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1))
  page?: number = 1;

  @ApiProperty({ example: 10, required: false, default: 10 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 10))
  limit?: number = 10;
}

export class CancelSubscriptionDto {
  @ApiProperty({ example: 'Switching to another provider', required: false })
  @IsString()
  @IsOptional()
  cancellationReason?: string;
}

export class ChangeSubscriptionPlanDto {
  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  newPlanId: string;

  @ApiProperty({
    enum: BillingCycle,
    example: BillingCycle.MONTHLY,
    required: false,
  })
  @IsEnum(BillingCycle)
  @IsOptional()
  billingCycle?: BillingCycle;
}

export class SubscriptionQueryDto {
  @ApiProperty({ enum: SubscriptionStatus, required: false })
  @IsEnum(SubscriptionStatus)
  @IsOptional()
  status?: SubscriptionStatus;

  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1))
  page?: number = 1;

  @ApiProperty({ example: 10, required: false, default: 10 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 10))
  limit?: number = 10;
}

export class BillingStatusQueryDto {}

export class BillingUsageQueryDto {}

export class BillingEventQueryDto {
  @ApiProperty({ example: 'SUBSCRIPTION_ACTIVATED', required: false })
  @IsString()
  @IsOptional()
  eventType?: string;

  @ApiProperty({ example: 1, required: false, default: 1 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 1))
  page?: number = 1;

  @ApiProperty({ example: 10, required: false, default: 10 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : 10))
  limit?: number = 10;
}

export class ExtendGracePeriodDto {
  @ApiProperty({ example: 7, required: false, default: 7 })
  @IsNumber()
  @Min(1)
  @IsOptional()
  additionalDays?: number = 7;
}

export class ManualBillingActionDto {
  @ApiProperty({ example: 'Manual admin action reason', required: false })
  @IsString()
  @IsOptional()
  reason?: string;
}

// ==========================================
// MICROSERVICE MESSAGE PAYLOAD WRAPPERS
// ==========================================

/**
 * Generic single-id microservice message payload, e.g. { id }.
 * Reused by handlers such as GET_PLAN_BY_ID, SUPERADMIN_GET_SUBSCRIPTION_BY_ID,
 * SUPERADMIN_SUSPEND_SUBSCRIPTION, SUPERADMIN_REACTIVATE_SUBSCRIPTION, MARK_PAST_DUE.
 */
export class IdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  id: string;
}

export class UpdatePlanMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ type: UpdatePlanDto })
  @ValidateNested()
  @Type(() => UpdatePlanDto)
  @IsDefined()
  dto: UpdatePlanDto;
}

export class UpdateSubscriptionStatusMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ enum: SubscriptionStatus, example: SubscriptionStatus.ACTIVE })
  @IsEnum(SubscriptionStatus)
  @IsNotEmpty()
  status: SubscriptionStatus;
}

export class CreatePaymentMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreatePaymentDto })
  @ValidateNested()
  @Type(() => CreatePaymentDto)
  @IsDefined()
  dto: CreatePaymentDto;
}

/**
 * Payload for BILLING.SIMULATE_PAYMENT. `tenantId` is mandatory so the
 * service can scope the payment lookup — without it the handler could be
 * driven to mutate any organization's payment by id alone.
 */
export class SimulatePaymentMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: ProcessPaymentDto })
  @ValidateNested()
  @Type(() => ProcessPaymentDto)
  @IsDefined()
  dto: ProcessPaymentDto;
}

export class GetPaymentsMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: PaymentQueryDto })
  @ValidateNested()
  @Type(() => PaymentQueryDto)
  @IsDefined()
  query: PaymentQueryDto;
}

export class TenantPaymentIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'f6b12f6a-04b3-4f8a-9892-9653d9e29999' })
  @IsUUID()
  @IsNotEmpty()
  paymentId: string;
}

export class CreateInvoiceMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: CreateInvoiceDto })
  @ValidateNested()
  @Type(() => CreateInvoiceDto)
  @IsDefined()
  dto: CreateInvoiceDto;
}

export class TenantInvoiceIdDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'a1b2c3d4-04b3-4f8a-9892-9653d9e29999' })
  @IsUUID()
  @IsNotEmpty()
  invoiceId: string;
}

export class GetInvoicesMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: InvoiceQueryDto })
  @ValidateNested()
  @Type(() => InvoiceQueryDto)
  @IsDefined()
  query: InvoiceQueryDto;
}

export class CancelSubscriptionMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  subscriptionId: string;

  @ApiProperty({ type: CancelSubscriptionDto })
  @ValidateNested()
  @Type(() => CancelSubscriptionDto)
  @IsDefined()
  dto: CancelSubscriptionDto;
}

/**
 * Reused by SUBSCRIPTION_SUSPEND, SUBSCRIPTION_REACTIVATE,
 * SUBSCRIPTION_RENEW, SUPERADMIN_GET_SUBSCRIPTION_INVOICES and
 * SUPERADMIN_GET_SUBSCRIPTION_PAYMENTS message patterns.
 */
export class SubscriptionIdMessageDto {
  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  subscriptionId: string;

  @ApiProperty({
    example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;
}

export class ChangeSubscriptionPlanMessageDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ example: 'e5c23f7b-15c4-5f9b-0903-0764e0f32294' })
  @IsUUID()
  @IsNotEmpty()
  subscriptionId: string;

  @ApiProperty({ type: ChangeSubscriptionPlanDto })
  @ValidateNested()
  @Type(() => ChangeSubscriptionPlanDto)
  @IsDefined()
  dto: ChangeSubscriptionPlanDto;
}

export class BillingEventsMessageDto {
  @ApiProperty({
    example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  tenantId?: string;

  @ApiProperty({ type: BillingEventQueryDto, required: false })
  @ValidateNested()
  @Type(() => BillingEventQueryDto)
  @IsOptional()
  query?: BillingEventQueryDto;
}

export class ThresholdDaysDto {
  @ApiProperty({ example: 7, required: false })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null ? parseInt(value, 10) : value,
  )
  thresholdDays?: number;
}

export class GracePeriodDaysDto {
  @ApiProperty({ example: 7, required: false })
  @IsNumber()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null ? parseInt(value, 10) : value,
  )
  gracePeriodDays?: number;
}

export class ExtendGracePeriodMessageDto extends ExtendGracePeriodDto {
  @ApiProperty({ example: 'd4b12f6a-04b3-4f8a-9892-9653d9e21183' })
  @IsUUID()
  @IsNotEmpty()
  id: string;
}
