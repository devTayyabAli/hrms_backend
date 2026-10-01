import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

/**
 * Logs every incoming @MessagePattern call with timing, on all three
 * microservices — auth-service, tenant-service, user-service. This is each
 * service's own request/performance visibility, independent of the gateway's
 * logging: even without a shared correlation ID reaching every handler (most
 * payloads are validated DTOs, not envelopes, so there's no generic
 * side-channel to carry one over plain TCP without breaking that validation
 * — see SignedMicroservicePayload for the one place that does carry one),
 * every microservice can now answer "what am I being asked to do, how long
 * does it take, is it failing" from its own logs.
 *
 * When the payload IS a SignedMicroservicePayload (see
 * microservice-auth.interface.ts) carrying context.correlationId, that ID is
 * logged too, giving true end-to-end correlation for those message patterns.
 */
@Injectable()
export class MicroserviceLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('IncomingMessage');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if ((context.getType() as string) !== 'rpc') {
      return next.handle();
    }

    const handlerName = `${context.getClass().name}.${context.getHandler().name}`;
    const correlationId = this.resolveCorrelationId(context.switchToRpc().getData());
    const prefix = correlationId ? `[${correlationId}] ` : '';
    const startedAt = Date.now();

    this.logger.log(`${prefix}--> ${handlerName}`);

    return next.handle().pipe(
      tap(() => {
        this.logger.log(`${prefix}<-- ${handlerName} OK (${Date.now() - startedAt}ms)`);
      }),
      catchError((err) => {
        this.logger.warn(`${prefix}<-- ${handlerName} FAILED (${Date.now() - startedAt}ms): ${err?.message || err}`);
        return throwError(() => err);
      }),
    );
  }

  private resolveCorrelationId(data: any): string | undefined {
    return data?.context?.correlationId || data?.correlationId;
  }
}
