import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@app/common';
import { PaymentProvider } from '../payment-provider.interface';
import {
  CreateProviderPaymentRequest,
  CreateProviderPaymentResponse,
  ProcessProviderPaymentRequest,
  ProcessProviderPaymentResponse,
  ProviderPaymentStatus,
  RefundProviderPaymentRequest,
  RefundProviderPaymentResponse,
} from '../payment-provider.types';

@Injectable()
export class InternalPaymentProvider implements PaymentProvider {
  readonly name = 'internal';
  private readonly logger = new Logger(InternalPaymentProvider.name);

  // In-memory status store for simulation & idempotency tracking
  private readonly paymentStore = new Map<string, ProviderPaymentStatus>();

  async createPayment(request: CreateProviderPaymentRequest): Promise<CreateProviderPaymentResponse> {
    const providerPaymentId = `INT_PAY_${request.internalPaymentId}_${Date.now()}`;
    const reference = `REF-INT-${Date.now()}`;

    const providerStatus: ProviderPaymentStatus = {
      providerPaymentId,
      status: PaymentStatus.PENDING,
      metadata: request.metadata,
    };

    this.paymentStore.set(providerPaymentId, providerStatus);
    this.logger.log(`[InternalPaymentProvider] Created payment ${providerPaymentId} for amount $${request.amount}`);

    return {
      providerName: this.name,
      providerPaymentId,
      status: PaymentStatus.PENDING,
      reference,
      metadata: request.metadata,
    };
  }

  async processPayment(request: ProcessProviderPaymentRequest): Promise<ProcessProviderPaymentResponse> {
    const existing = this.paymentStore.get(request.providerPaymentId);
    const now = new Date();

    if (request.action === 'SUCCESS') {
      const transactionId = `TXN_INT_${Date.now()}`;
      const statusResponse: ProcessProviderPaymentResponse = {
        providerPaymentId: request.providerPaymentId,
        status: PaymentStatus.SUCCESS,
        transactionId,
        paidAt: now,
        metadata: request.metadata,
      };

      this.paymentStore.set(request.providerPaymentId, {
        providerPaymentId: request.providerPaymentId,
        status: PaymentStatus.SUCCESS,
        transactionId,
        paidAt: now,
        metadata: request.metadata,
      });

      this.logger.log(`[InternalPaymentProvider] Payment ${request.providerPaymentId} succeeded with TXN ${transactionId}`);
      return statusResponse;
    } else {
      const statusResponse: ProcessProviderPaymentResponse = {
        providerPaymentId: request.providerPaymentId,
        status: PaymentStatus.FAILED,
        transactionId: `TXN_FAIL_${Date.now()}`,
        failureReason: request.failureReason || 'Internal simulation payment failed',
        metadata: request.metadata,
      };

      this.paymentStore.set(request.providerPaymentId, {
        providerPaymentId: request.providerPaymentId,
        status: PaymentStatus.FAILED,
        metadata: request.metadata,
      });

      this.logger.warn(`[InternalPaymentProvider] Payment ${request.providerPaymentId} failed. Reason: ${statusResponse.failureReason}`);
      return statusResponse;
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const status = this.paymentStore.get(providerPaymentId);
    if (status) {
      return status;
    }

    return {
      providerPaymentId,
      status: PaymentStatus.PENDING,
    };
  }

  async refundPayment(request: RefundProviderPaymentRequest): Promise<RefundProviderPaymentResponse> {
    const refundId = `RFD_INT_${Date.now()}`;
    this.logger.log(`[InternalPaymentProvider] Refund ${refundId} issued for ${request.providerPaymentId}`);

    return {
      providerPaymentId: request.providerPaymentId,
      refundId,
      status: PaymentStatus.REFUNDED,
      refundedAt: new Date(),
    };
  }
}
