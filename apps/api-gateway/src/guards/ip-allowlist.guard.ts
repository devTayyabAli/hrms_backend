import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { IS_PUBLIC_KEY, SERVICES, MESSAGE_PATTERNS } from '@app/common';

interface IpDecision {
  allowed: boolean;
  /** True when an administrator has the allowlist switched on. */
  enforcing: boolean;
}

/**
 * Enforces the Security tab's "IP Access Control" allowlist on the routes it
 * guards. The allowlist lives in auth-service's database (it's admin-editable
 * at runtime), so unlike the other guards in this codebase — which read only
 * JWT claims already on the request — this one has to ask auth-service.
 *
 * Decisions are cached per IP for a short TTL. Without that, every request to
 * a guarded route paid a synchronous TCP round trip to answer a question
 * whose answer changes only when an administrator edits the list.
 *
 * On a lookup failure the behavior depends on what we last knew:
 *
 *   - allowlist known to be OFF, or never successfully observed: fail OPEN.
 *     A settings-lookup outage must not lock every administrator out of a
 *     platform that was not restricting them in the first place, and these
 *     routes still sit behind JwtAuthGuard + SuperAdminGuard.
 *
 *   - allowlist known to be ON: fail CLOSED (503). This is the case the
 *     previous unconditional fail-open got wrong: an administrator had
 *     deliberately restricted access by source IP, and anyone who could make
 *     auth-service time out — including simply waiting for it to be
 *     redeployed — got the control switched off for the duration. A control
 *     that evaporates under load is not a control. 503 rather than 403
 *     because this is "cannot decide", not "you are not on the list".
 */
@Injectable()
export class IpAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(IpAllowlistGuard.name);

  private readonly ttlMs = parseInt(
    process.env.IP_ALLOWLIST_TTL_MS || '15000',
    10,
  );

  private readonly cache = new Map<
    string,
    { decision: IpDecision; at: number }
  >();

  /**
   * Last observed value of the global "is the allowlist switched on" flag,
   * independent of any particular IP. This is what a failed lookup falls back
   * to, so it deliberately outlives the per-IP TTL.
   */
  private lastKnownEnforcing: boolean | null = null;

  /** De-duplicates concurrent lookups for the same IP (thundering herd). */
  private readonly inFlight = new Map<string, Promise<IpDecision>>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  /** Drops cached decisions so an allowlist edit applies immediately. */
  invalidate(): void {
    this.cache.clear();
  }

  private async resolve(ip: string): Promise<IpDecision> {
    const hit = this.cache.get(ip);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.decision;
    }

    const pending = this.inFlight.get(ip);
    if (pending) {
      return pending;
    }

    const lookup = firstValueFrom(
      this.authClient
        .send<Partial<IpDecision>>(MESSAGE_PATTERNS.SETTINGS.CHECK_IP_ALLOWED, {
          ip,
        })
        .pipe(timeout(3000)),
    )
      .then((result): IpDecision => {
        const decision: IpDecision = {
          allowed: result?.allowed !== false,
          // Absent `enforcing` means an auth-service older than this guard.
          // Treat that as "not enforcing" so a rolling deploy degrades to the
          // previous fail-open behavior rather than 503ing the admin panel.
          enforcing: result?.enforcing === true,
        };
        this.cache.set(ip, { decision, at: Date.now() });
        this.lastKnownEnforcing = decision.enforcing;
        return decision;
      })
      .finally(() => {
        this.inFlight.delete(ip);
      });

    this.inFlight.set(ip, lookup);
    return lookup;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() === 'rpc') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const ip: string = request.ip || request.socket?.remoteAddress || '';

    let decision: IpDecision;
    try {
      decision = await this.resolve(ip);
    } catch (err: any) {
      if (this.lastKnownEnforcing === true) {
        this.logger.error(
          `IP allowlist check failed while the allowlist is enforcing — refusing the request rather than bypassing the control: ${err.message}`,
        );
        throw new ServiceUnavailableException(
          'Unable to verify IP access control. Please try again shortly.',
        );
      }
      this.logger.warn(
        `IP allowlist check unavailable and no allowlist known to be active, allowing request through: ${err.message}`,
      );
      return true;
    }

    if (!decision.allowed) {
      throw new ForbiddenException(
        `Access from IP address ${ip} is not permitted by the platform IP allowlist.`,
      );
    }
    return true;
  }
}
