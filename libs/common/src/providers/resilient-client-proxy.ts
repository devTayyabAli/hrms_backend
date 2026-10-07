import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable, TimeoutError, throwError, timer } from 'rxjs';
import { catchError, retry, tap, timeout } from 'rxjs/operators';

export interface ResilientClientProxyOptions {
  /** Human-readable name used in timeout/unavailable error messages. */
  serviceName: string;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  breakerFailureThreshold?: number;
  breakerCooldownMs?: number;
  /**
   * Resolves the current request's correlation ID for log prefixing. Passed
   * as a callback (rather than importing a concrete context service here) so
   * this class stays dependency-free of any particular request-context
   * implementation — the caller supplies the resolver at construction time.
   */
  getCorrelationId?: () => string | undefined;
  /**
   * Stamps an HMAC signature (and the caller's identity) onto every outgoing
   * payload, so the receiving service can tell a message that came through
   * this gateway from one sent straight to its TCP port.
   *
   * Supplied as a callback for the same reason as `getCorrelationId`: this
   * class stays free of any particular context or config implementation, and
   * a deployment that has not configured a signing secret simply omits it.
   *
   * Signing belongs here rather than at each call site because that is the
   * only way it covers everything. The per-call-site approach it replaces had
   * been applied to thirteen of roughly 260 message patterns — the other
   * ~95% were reachable unsigned, and nothing about adding a new controller
   * method prompted anyone to remember.
   */
  signPayload?: <T>(data: T) => T;
}

type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Minimal per-service circuit breaker: after `failureThreshold` consecutive
 * infrastructure failures (timeouts, connection errors — never curated 4xx
 * business errors, which mean the service is up and responding correctly),
 * trips open and fails fast for `cooldownMs` instead of piling up more
 * timed-out requests against an already-struggling service. After the
 * cooldown, lets a single trial request through (half-open) to probe recovery.
 */
class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  canAttempt(): boolean {
    if (this.state !== 'open') return true;
    if (Date.now() - this.openedAt < this.cooldownMs) return false;
    this.state = 'half-open';
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

const IDEMPOTENT_ACTION_PREFIXES = ['get', 'list', 'query', 'check', 'validate', 'resolve', 'search'];

/**
 * True for read-only message patterns ("<domain>.<action>", e.g. "role.get_all")
 * — the only ones safe to transparently retry after a timeout. Mutating
 * patterns (create/update/delete/cancel/activate/assign/...) are NEVER
 * auto-retried: this system has no request-idempotency-key mechanism, so
 * retrying a mutating call whose first attempt actually succeeded
 * server-side (but whose response was merely delayed) could duplicate the
 * side effect — double-charge a payment, create a role twice, etc.
 */
export function isIdempotentPattern(pattern: unknown): boolean {
  if (typeof pattern !== 'string') return false;
  const action = pattern.split('.').pop() || pattern;
  return IDEMPOTENT_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

/** The transport itself failed — the request may never have reached the service. */
function isConnectionFailure(err: any): boolean {
  return (
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET/i.test(err?.message || err?.toString?.() || '')
  );
}

function isInfrastructureFailure(err: any): boolean {
  return (
    err instanceof TimeoutError ||
    err?.name === 'TimeoutError' ||
    err?.name === 'AggregateError' ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ECONNRESET' ||
    /ECONNREFUSED|ECONNRESET|socket|AggregateError/i.test(err?.message || err?.toString?.() || '')
  );
}

/**
 * Wraps a raw TCP ClientProxy with a consistent timeout, safe-only retry,
 * and a lightweight per-service circuit breaker. Registered as the DI
 * provider in place of the raw ClientProxy (see api-gateway.module.ts), so
 * every controller that injects a microservice client gets this behavior
 * automatically — no per-call-site `.pipe(timeout(...))` needed, and
 * nothing for new code to forget.
 */
export class ResilientClientProxy {
  private readonly logger: Logger;
  private readonly serviceName: string;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly retryDelayMs: number;
  private readonly breaker: CircuitBreaker;
  private readonly getCorrelationId?: () => string | undefined;
  private readonly signPayload?: <T>(data: T) => T;

  constructor(
    private readonly client: ClientProxy,
    options: ResilientClientProxyOptions,
  ) {
    this.serviceName = options.serviceName;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.retryCount = options.retryCount ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.breaker = new CircuitBreaker(
      options.breakerFailureThreshold ?? 5,
      options.breakerCooldownMs ?? 30000,
    );
    this.getCorrelationId = options.getCorrelationId;
    this.signPayload = options.signPayload;
    this.logger = new Logger(`MicroserviceClient:${this.serviceName}`);
  }

  /**
   * Signs `data` unless it is already signed.
   *
   * The pass-through matters: a handful of call sites build the nested
   * `SignedMicroservicePayload` envelope explicitly, because the handler on
   * the other end reads the caller's identity out of it. Signing that again
   * would nest one envelope inside another and the receiver would verify the
   * outer one, then hand the handler an envelope whose `data` is itself an
   * envelope.
   */
  private prepare<T>(data: T): T {
    if (!this.signPayload) return data;

    const candidate = data as unknown as Record<string, unknown> | null;
    const alreadySigned =
      typeof candidate === 'object' &&
      candidate !== null &&
      'signature' in candidate &&
      'timestamp' in candidate &&
      'context' in candidate &&
      'data' in candidate;

    return alreadySigned ? data : this.signPayload(data);
  }

  /**
   * `timeoutMs` overrides the instance default for this one call — for the
   * rare pattern that is legitimately slow (e.g. `org.create_initial`, whose
   * first-ever write to a brand-new tenant database can trigger a full
   * schema sync taking tens of seconds), rather than raising the timeout for
   * every call this client makes just to accommodate the one slow outlier.
   */
  send<TResult = any, TInput = any>(
    pattern: any,
    input: TInput,
    timeoutMs?: number,
  ): Observable<TResult> {
    const data = this.prepare(input);
    const correlationId = this.getCorrelationId?.();
    const logPrefix = correlationId ? `[${correlationId}] ` : '';

    if (!this.breaker.canAttempt()) {
      this.logger.warn(`${logPrefix}Circuit open — failing fast for pattern "${pattern}" without attempting the call.`);
      return throwError(
        () => new ServiceUnavailableException(`${this.serviceName} is temporarily unavailable. Please try again shortly.`),
      );
    }

    const startedAt = Date.now();
    this.logger.debug(`${logPrefix}--> ${pattern}`);

    let source$ = this.client
      .send<TResult, TInput>(pattern, data)
      .pipe(timeout(timeoutMs ?? this.timeoutMs));

    if (isIdempotentPattern(pattern)) {
      // Only a dropped or refused connection is worth another attempt. A
      // business error (not found, validation, forbidden) is the service's
      // real answer, and retrying it just ran the handler three times and
      // added 2s to every such response. A timeout isn't retried either: the
      // service is slow, and asking again makes the caller wait 3× as long.
      source$ = source$.pipe(
        retry({
          count: this.retryCount,
          delay: (err) => (isConnectionFailure(err) ? timer(this.retryDelayMs) : throwError(() => err)),
        }),
      );
    }

    return source$.pipe(
      tap({
        next: () => {
          this.breaker.recordSuccess();
          this.logger.debug(`${logPrefix}<-- ${pattern} OK (${Date.now() - startedAt}ms)`);
        },
        error: (err) => {
          if (isInfrastructureFailure(err)) this.breaker.recordFailure();
        },
      }),
      catchError((err) => {
        if (isInfrastructureFailure(err)) {
          this.logger.error(`${logPrefix}<-- ${pattern} FAILED (${Date.now() - startedAt}ms): ${err?.message || err}`);
          return throwError(
            () => new ServiceUnavailableException(`${this.serviceName} did not respond in time. Please try again.`),
          );
        }
        return throwError(() => err);
      }),
    );
  }

  emit<TResult = any, TInput = any>(pattern: any, data: TInput): Observable<TResult> {
    return this.client.emit<TResult, TInput>(pattern, this.prepare(data));
  }

  connect(): Promise<any> {
    return this.client.connect();
  }

  close(): void {
    this.client.close();
  }
}
