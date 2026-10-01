import {
  CreateProviderPaymentRequest,
  CreateProviderPaymentResponse,
  ProcessProviderPaymentRequest,
  ProcessProviderPaymentResponse,
  ProviderPaymentStatus,
  RefundProviderPaymentRequest,
  RefundProviderPaymentResponse,
} from './payment-provider.types';

export interface PaymentProvider {
  /**
   * Unique name of the payment provider adapter (e.g. 'internal', 'stripe', 'paypal')
   */
  readonly name: string;

  /**
   * Create payment transaction at provider level
   */
  createPayment(request: CreateProviderPaymentRequest): Promise<CreateProviderPaymentResponse>;

  /**
   * Process/simulate payment status change (SUCCESS/FAILED)
   */
  processPayment(request: ProcessProviderPaymentRequest): Promise<ProcessProviderPaymentResponse>;

  /**
   * Query status of provider payment
   */
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus>;

  /**
   * Optional refund capability
   */
  refundPayment?(request: RefundProviderPaymentRequest): Promise<RefundProviderPaymentResponse>;
}
