import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { tenantStorage, TenantContext } from '../context/tenant-context.service';

export const CurrentTenant = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const contextStore = tenantStorage.getStore() || {
      tenantId: request.tenantId || request.user?.tenantId,
      userId: request.user?.id || request.user?.sub,
      requestId: request.requestId,
    };

    if (data) {
      return contextStore[data];
    }

    return contextStore;
  },
);
