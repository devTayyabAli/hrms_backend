import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId?: string;
  tenantSlug?: string;
  tenantStatus?: string;
  requestId?: string;
  userId?: string;
  roles?: string[];
  permissions?: string[];
  email?: string;
  /** JWT `dataScope` claim — see `DataScope` in @app/common. */
  dataScope?: string;
  isFullAccess?: boolean;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

@Injectable()
export class TenantContextService {
  /**
   * Safely run callback within AsyncLocalStorage context boundary
   */
  run<T>(context: TenantContext, callback: () => T): T {
    return tenantStorage.run(context, callback);
  }

  /**
   * Set or update current context
   */
  setContext(context: Partial<TenantContext>): void {
    // Mutated in place when a request context exists, so the change is seen
    // by every continuation of the request, not only the caller's own —
    // `enterWith` alone is lost across the awaits between guards and handler.
    const current = tenantStorage.getStore();
    if (current) {
      Object.assign(current, context);
      return;
    }
    tenantStorage.enterWith({ ...context });
  }

  /**
   * Get full tenant context
   */
  getContext(): TenantContext | undefined {
    return tenantStorage.getStore();
  }

  /**
   * Get tenant ID
   */
  getTenantId(): string | undefined {
    const store = tenantStorage.getStore();
    return store?.tenantId;
  }

  /**
   * Get user ID
   */
  getUserId(): string | undefined {
    const store = tenantStorage.getStore();
    return store?.userId;
  }

  /**
   * Get request ID
   */
  getRequestId(): string | undefined {
    const store = tenantStorage.getStore();
    return store?.requestId;
  }

  /**
   * Clear current context
   */
  clearContext(): void {
    tenantStorage.enterWith({});
  }
}
