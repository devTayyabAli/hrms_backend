import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import type { Request, Response } from 'express';
import {
  catchError,
  firstValueFrom,
  from,
  Observable,
  switchMap,
  tap,
  throwError,
  timeout,
} from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';
import {
  AUDITED_KEY,
  AuditContext,
  AuditedOptions,
  AuditService,
} from './audited.decorator';

/** Never written to the trail, whatever route they arrive on. */
const SECRET_FIELD =
  /pass(word)?|secret|token|otp|apikey|api_key|privatekey|credential/i;

/** "sessionIdleTimeoutMinutes" → "Session idle timeout minutes"; acronyms like 2FA and IP stay as they are. */
export const humanizeField = (key: string) => {
  const words = key.match(
    /\d+[A-Z]*(?=[A-Z][a-z]|\d|[^A-Za-z]|$)|[A-Z]{2,}s(?=[A-Z]|\d|[^A-Za-z]|$)|[A-Z]{2,}(?=[A-Z][a-z]|\d|[^A-Za-z]|$)|[A-Z]?[a-z]+|[A-Z]+|\d+/g,
  ) ?? [key];
  const text = words
    .map((w) =>
      /^[A-Z0-9]{2,}s?$/.test(w) && /[A-Z]/.test(w) ? w : w.toLowerCase(),
    )
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export const displayValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (Array.isArray(value))
    return value.length ? value.map((v) => displayValue(v)).join(', ') : '—';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  }
  const text = String(value);
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
};

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field-by-field differences between the record before and what was sent. */
export const diffChanges = (
  before: Record<string, any> | null | undefined,
  body: Record<string, any> | null | undefined,
) => {
  if (!before || !body || typeof body !== 'object') return [];
  return Object.keys(body)
    .filter(
      (key) =>
        !SECRET_FIELD.test(key) &&
        key in before &&
        !same(before[key], body[key]),
    )
    .map((key) => ({
      field: humanizeField(key),
      before: displayValue(before[key]),
      after: displayValue(body[key]),
    }));
};

const errorMessage = (error: any): string => {
  const raw =
    error?.response?.message ??
    error?.message ??
    error?.error?.message ??
    error;
  const text = Array.isArray(raw)
    ? raw.join('; ')
    : typeof raw === 'string'
      ? raw
      : 'The action failed.';
  return text.slice(0, 500);
};

/**
 * Writes the platform audit trail for routes marked `@Audited`: who did what
 * to which organization, from where, whether it worked, and — for edits —
 * which fields changed from what to what.
 *
 * Recording never delays or breaks the request: it is sent after the
 * response is decided and its failure is only logged. A failed action is
 * recorded too, with the reason, then the original error is rethrown.
 */
@Injectable()
export class AuditTrailInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditTrailInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<AuditedOptions | undefined>(
      AUDITED_KEY,
      context.getHandler(),
    );
    if (!options || context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request & { user?: any }>();
    const res = context.switchToHttp().getResponse<Response>();
    const ctx: AuditContext = {
      req,
      params: (req.params ?? {}) as Record<string, string>,
      body: req.body,
      query: req.query,
    };

    return from(this.takeSnapshot(options, ctx)).pipe(
      switchMap((before) => {
        ctx.before = before;
        return next.handle().pipe(
          tap((result) => {
            ctx.result = result;
            // A handler that writes the response itself can still answer with an error status.
            const failed = res.statusCode >= 400;
            this.record(
              options,
              ctx,
              failed ? 'Failed' : 'Success',
              failed ? `Request answered with ${res.statusCode}` : undefined,
            );
          }),
          catchError((error) => {
            this.record(options, ctx, 'Failed', errorMessage(error));
            return throwError(() => error);
          }),
        );
      }),
    );
  }

  private client(service: AuditService): ClientProxy {
    return service === 'auth'
      ? this.authClient
      : service === 'user'
        ? this.userClient
        : this.tenantClient;
  }

  private async takeSnapshot(
    options: AuditedOptions,
    ctx: AuditContext,
  ): Promise<any> {
    if (!options.snapshot) return undefined;
    try {
      const payload = options.snapshot.payload
        ? options.snapshot.payload(ctx)
        : {};
      const raw = await firstValueFrom(
        this.client(options.snapshot.service)
          .send(options.snapshot.pattern, payload)
          .pipe(timeout(8000)),
      );
      return options.snapshot.pick ? options.snapshot.pick(raw, ctx) : raw;
    } catch (error) {
      // The action still runs; the entry just has no before-values.
      this.logger.debug(`Audit snapshot failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private record(
    options: AuditedOptions,
    ctx: AuditContext,
    status: 'Success' | 'Failed',
    reason?: string,
  ) {
    try {
      const user = ctx.req.user ?? {};
      const isSuperAdmin =
        user.isSuperAdmin === true ||
        (Array.isArray(user.roles) && user.roles.includes('superadmin'));
      const action =
        typeof options.action === 'function'
          ? options.action(ctx)
          : options.action;
      const result =
        ctx.result && typeof ctx.result === 'object' ? ctx.result : {};
      const before =
        ctx.before && typeof ctx.before === 'object' ? ctx.before : {};

      const tenantId =
        (options.tenantParam && ctx.params[options.tenantParam]) ||
        (typeof result.tenantId === 'string' ? result.tenantId : undefined) ||
        (typeof before.tenantId === 'string' ? before.tenantId : undefined);
      // Taken from the snapshot so a deleted organization keeps its name in the trail.
      const organizationName =
        (options.tenantParam && (before.organizationName || before.name)) ||
        (typeof result.organizationName === 'string'
          ? result.organizationName
          : undefined);

      let subject: string | undefined;
      try {
        subject = options.subject?.(ctx) ?? undefined;
      } catch {
        subject = undefined;
      }

      const entry = {
        action,
        module: options.module,
        status,
        reason,
        actorType: isSuperAdmin
          ? 'superadmin'
          : user.tenantId
            ? 'tenant'
            : 'unknown',
        userId: user.id || user.sub,
        email: user.email,
        tenantId,
        organizationName: organizationName || undefined,
        actionDetails: subject ? String(subject).slice(0, 250) : undefined,
        changes:
          options.diff && status === 'Success'
            ? diffChanges(ctx.before, ctx.body)
            : undefined,
        ipAddress:
          String(ctx.req.ip || ctx.req.socket?.remoteAddress || '').replace(
            /^::ffff:(?=\d)/i,
            '',
          ) || undefined,
        userAgent: ctx.req.headers['user-agent'],
      };

      this.authClient
        .send(MESSAGE_PATTERNS.AUDIT.RECORD, entry)
        .pipe(timeout(10000))
        .subscribe({
          error: (error) =>
            this.logger.warn(
              `Audit entry "${action}" not written: ${errorMessage(error)}`,
            ),
        });
    } catch (error) {
      this.logger.warn(`Audit entry not built: ${errorMessage(error)}`);
    }
  }
}
