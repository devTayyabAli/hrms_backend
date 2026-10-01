import { HttpStatus } from '@nestjs/common';
import { PaymentStatus, InvoiceStatus, SubscriptionStatus, TenantException, TenantErrorCode } from '@app/common';

export class BillingStateMachine {
  /**
   * Validate payment status transition.
   * Throws TenantException if transition is illegal.
   */
  static validatePaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
    if (from === to) {
      return; // Idempotent replay permitted
    }

    const validTransitions: Record<PaymentStatus, PaymentStatus[]> = {
      [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING, PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.CANCELLED],
      [PaymentStatus.PROCESSING]: [PaymentStatus.SUCCESS, PaymentStatus.FAILED, PaymentStatus.CANCELLED],
      [PaymentStatus.SUCCESS]: [PaymentStatus.REFUNDED],
      [PaymentStatus.FAILED]: [], // FAILED is terminal unless retried via new Payment entity
      [PaymentStatus.CANCELLED]: [],
      [PaymentStatus.REFUNDED]: [],
    };

    const allowed = validTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new TenantException(
        TenantErrorCode.INVALID_BILLING_ACTION,
        `Invalid Payment status transition from '${from}' to '${to}'.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Validate invoice status transition.
   * Throws TenantException if transition is illegal.
   */
  static validateInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): void {
    if (from === to) {
      return; // Idempotent replay permitted
    }

    const validTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
      [InvoiceStatus.DRAFT]: [InvoiceStatus.OPEN, InvoiceStatus.VOID],
      [InvoiceStatus.OPEN]: [InvoiceStatus.PAID, InvoiceStatus.OVERDUE, InvoiceStatus.VOID, InvoiceStatus.CANCELLED],
      [InvoiceStatus.OVERDUE]: [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.CANCELLED],
      [InvoiceStatus.PAID]: [], // Terminal state; cannot be voided or un-paid directly
      [InvoiceStatus.VOID]: [],
      [InvoiceStatus.CANCELLED]: [],
    };

    const allowed = validTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new TenantException(
        TenantErrorCode.INVALID_BILLING_ACTION,
        `Invalid Invoice status transition from '${from}' to '${to}'.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Validate subscription status transition.
   * Throws TenantException if transition is illegal.
   */
  static validateSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
    if (from === to) {
      return; // Idempotent replay permitted
    }

    const validTransitions: Record<SubscriptionStatus, SubscriptionStatus[]> = {
      [SubscriptionStatus.TRIAL]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PENDING_PAYMENT, SubscriptionStatus.CANCELLED],
      [SubscriptionStatus.PENDING_PAYMENT]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED],
      [SubscriptionStatus.ACTIVE]: [SubscriptionStatus.PAST_DUE, SubscriptionStatus.SUSPENDED, SubscriptionStatus.CANCELLED],
      [SubscriptionStatus.PAST_DUE]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.SUSPENDED, SubscriptionStatus.CANCELLED],
      [SubscriptionStatus.SUSPENDED]: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELLED],
      [SubscriptionStatus.CANCELLED]: [SubscriptionStatus.ACTIVE], // Reactivation path
    };

    const allowed = validTransitions[from] || [];
    if (!allowed.includes(to)) {
      throw new TenantException(
        TenantErrorCode.INVALID_BILLING_ACTION,
        `Invalid Subscription status transition from '${from}' to '${to}'.`,
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
