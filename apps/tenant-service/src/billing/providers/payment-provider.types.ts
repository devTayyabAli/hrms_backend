import { PaymentStatus, PaymentMethod, BillingCycle } from '@app/common';

export interface CreateProviderPaymentRequest {
  internalPaymentId: string;
  tenantId: string;
  subscriptionId: string;
  amount: number;
  currency: string;
  billingCycle: BillingCycle;
  paymentMethod: PaymentMethod;
  metadata?: any;
}

export interface CreateProviderPaymentResponse {
  providerName: string;
  providerPaymentId: string;
  status: PaymentStatus;
  reference: string;
  metadata?: any;
}

export interface ProcessProviderPaymentRequest {
  providerPaymentId: string;
  paymentId: string;
  action: 'SUCCESS' | 'FAILED';
  failureReason?: string;
  metadata?: any;
}

export interface ProcessProviderPaymentResponse {
  providerPaymentId: string;
  status: PaymentStatus;
  transactionId: string;
  paidAt?: Date;
  failureReason?: string;
  metadata?: any;
}

export interface ProviderPaymentStatus {
  providerPaymentId: string;
  status: PaymentStatus;
  transactionId?: string;
  paidAt?: Date;
  metadata?: any;
}

export interface RefundProviderPaymentRequest {
  providerPaymentId: string;
  amount: number;
  reason?: string;
}

export interface RefundProviderPaymentResponse {
  providerPaymentId: string;
  refundId: string;
  status: PaymentStatus;
  refundedAt: Date;
}
