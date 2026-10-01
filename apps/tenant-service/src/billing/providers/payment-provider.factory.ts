import { Injectable, Logger, HttpStatus, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantException, TenantErrorCode } from '@app/common';
import { PaymentProvider } from './payment-provider.interface';
import { InternalPaymentProvider } from './internal/internal-payment.provider';

@Injectable()
export class PaymentProviderFactory implements OnModuleInit {
  private readonly logger = new Logger(PaymentProviderFactory.name);
  private readonly providersMap = new Map<string, PaymentProvider>();

  constructor(
    private readonly configService: ConfigService,
    private readonly internalPaymentProvider: InternalPaymentProvider,
  ) {}

  onModuleInit() {
    // Automatically register default Internal Payment Provider
    this.registerProvider(this.internalPaymentProvider);
    this.logger.log('PaymentProviderFactory initialized. InternalPaymentProvider registered as default.');
  }

  /**
   * Register a new PaymentProvider adapter dynamically
   */
  public registerProvider(provider: PaymentProvider): void {
    if (!provider || !provider.name) {
      throw new TenantException(
        TenantErrorCode.INVALID_BILLING_ACTION,
        'Cannot register invalid payment provider adapter.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const key = provider.name.toLowerCase();
    this.providersMap.set(key, provider);
    this.logger.log(`PaymentProvider '${provider.name}' registered successfully.`);
  }

  /**
   * Resolve a registered PaymentProvider by name, or return configured default
   */
  public getProvider(providerName?: string): PaymentProvider {
    const defaultProvider = this.configService.get<string>('PAYMENT_PROVIDER', 'internal');
    const targetName = (providerName || defaultProvider || 'internal').toLowerCase();

    const provider = this.providersMap.get(targetName);
    if (!provider) {
      this.logger.error(`Requested payment provider '${targetName}' is not registered or supported.`);
      throw new TenantException(
        TenantErrorCode.PAYMENT_PROVIDER_NOT_FOUND,
        `Payment provider '${targetName}' is not supported or active. Please use 'internal'.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return provider;
  }
}
