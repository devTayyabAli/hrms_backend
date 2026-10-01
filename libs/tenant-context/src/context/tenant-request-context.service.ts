import { Injectable, Scope } from '@nestjs/common';
import { TenantConnectionOptions } from '@app/database';

@Injectable({ scope: Scope.REQUEST })
export class TenantRequestContextService {
  private tenantId?: string;
  private connectionOptions?: TenantConnectionOptions;

  setTenantId(tenantId: string): void {
    this.tenantId = tenantId;
  }

  getTenantId(): string | undefined {
    return this.tenantId;
  }

  setConnectionOptions(options: TenantConnectionOptions): void {
    this.connectionOptions = options;
    if (options.tenantId) {
      this.tenantId = options.tenantId;
    }
  }

  getConnectionOptions(): TenantConnectionOptions | undefined {
    return this.connectionOptions;
  }
}
