import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { JwtService } from '@nestjs/jwt';
import { SERVICES, MESSAGE_PATTERNS } from '@app/common';

interface MaintenanceState {
  enabled: boolean;
  message: string;
  /** SUPER_ADMINS_ONLY, or ALL_ADMINS to also let organization admins in. */
  allowedAdmins?: string;
}

/** An organization admin by the claims on their token: full access, or an admin role. */
const isOrganizationAdmin = (user: any): boolean => {
  if (!user) return false;
  if (user.isFullAccess === true) return true;
  const roles: string[] = Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : [];
  return roles.some((role) => /admin/i.test(String(role)));
};

/**
 * Enforces the Maintenance tab's "Maintenance Mode" toggle: while it is on,
 * everyone except platform staff gets a 503 carrying the configured message.
 *
 * Registered globally, so it runs before route-level guards and cannot rely
 * on `request.user` being populated yet — the exemption is therefore decided
 * by path. `/superadmin/*` stays reachable (that is where the toggle gets
 * turned back off, so locking it would be a one-way door) along with the
 * health probes load balancers depend on.
 *
 * Fails OPEN if auth-service is unreachable: a settings-lookup outage must
 * not take the whole platform down.
 */
@Injectable()
export class MaintenanceModeGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceModeGuard.name);

  private static readonly EXEMPT_PATH_PATTERNS = [
    /\/superadmin(\/|$)/,
    /\/health(\/|$)/,
    /\/profile(\/|$)/,
    // A session's own housekeeping: renewing a token or signing out is
    // harmless, and blocking refresh would sign out the very admins who are
    // allowed in once their access token expires.
    /\/auth\/(refresh|logout|session)(\/|$)/,
  ];

  /** Lets settings writes drop the cache of whichever instance Nest created. */
  private static instance: MaintenanceModeGuard | null = null;

  static invalidateAll(): void {
    MaintenanceModeGuard.instance?.invalidate();
  }

  /**
   * Cached maintenance state, refreshed at most once per TTL.
   *
   * This guard is global, so before caching it put a synchronous TCP
   * round-trip to auth-service in front of very nearly every HTTP request the
   * platform serves — for a flag that changes maybe a few times a year. That
   * made auth-service latency the floor for all traffic and multiplied its
   * connection load by the gateway's entire request rate.
   *
   * A short TTL is the right trade here rather than invalidation-on-write:
   * the only cost of staleness is that turning maintenance mode on or off
   * takes up to TTL seconds to propagate, which is well inside the time it
   * takes an operator to notice either way.
   */
  private cachedState: MaintenanceState | null = null;
  private cachedAt = 0;

  private readonly ttlMs = parseInt(
    process.env.MAINTENANCE_STATE_TTL_MS || '60000',
    10,
  );

  /**
   * De-duplicates concurrent refreshes. Without this, a burst of requests
   * arriving on a cold or just-expired cache would each start its own lookup
   * — a thundering herd on exactly the dependency the cache exists to
   * protect.
   */
  private inFlight: Promise<MaintenanceState> | null =
    null;

  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly jwtService: JwtService,
  ) {
    MaintenanceModeGuard.instance = this;
  }

  /**
   * The verified claims on the request's bearer token, if any. This guard is
   * global and runs before the controllers' JwtAuthGuard, so `request.user`
   * isn't set yet; reading the token here is what lets an allowed admin
   * through. A forged or expired token simply verifies to nothing.
   */
  private tokenUser(request: any): any | null {
    if (request.user) return request.user;
    const header: string = request.headers?.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return null;
    try {
      const payload: any = this.jwtService.verify(token);
      return payload?.type && payload.type !== 'access' ? null : payload;
    } catch {
      return null;
    }
  }

  /** Drops the cache so an operator toggling the flag sees it apply at once. */
  invalidate(): void {
    this.cachedState = null;
    this.cachedAt = 0;
  }

  private async resolveState(): Promise<MaintenanceState> {
    if (this.cachedState && Date.now() - this.cachedAt < this.ttlMs) {
      return this.cachedState;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = firstValueFrom(
      this.authClient
        .send<MaintenanceState>(
          MESSAGE_PATTERNS.SETTINGS.GET_MAINTENANCE_STATE,
          {},
        )
        .pipe(timeout(3000)),
    )
      .then((state) => {
        this.cachedState = state;
        this.cachedAt = Date.now();
        return state;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const path: string = request.path || request.url || '';

    if (
      MaintenanceModeGuard.EXEMPT_PATH_PATTERNS.some((pattern) =>
        pattern.test(path),
      )
    ) {
      return true;
    }

    let state: MaintenanceState;
    try {
      state = await this.resolveState();
    } catch (err: any) {
      // Fails OPEN, and deliberately: a settings-lookup outage must not take
      // the whole platform down. Note this is a genuine trade-off — it means
      // an auth-service outage also disables maintenance mode — but the
      // alternative (fail closed) turns one service's downtime into a total
      // outage, which is strictly worse for a flag that is off almost always.
      this.logger.warn(
        `Maintenance state unavailable, allowing request through: ${err.message}`,
      );
      return true;
    }

    if (!state?.enabled) {
      return true;
    }

    // A superadmin token still gets through even on a non-exempt path, so
    // platform staff can verify the system while it is closed to everyone else.
    const user = this.tokenUser(request);
    const roles: string[] = Array.isArray(user?.roles) ? user.roles : user?.role ? [user.role] : [];
    if (roles.includes('superadmin') || user?.isSuperAdmin === true) {
      return true;
    }

    if (state.allowedAdmins === 'ALL_ADMINS') {
      // Organization admins may work during maintenance. Their sign-in goes
      // through to auth-service, which refuses anyone who isn't an admin.
      if (/\/auth\/login(\/|$)/.test(path) || /\/auth\/2fa(\/|$)/.test(path)) return true;
      if (isOrganizationAdmin(user)) return true;
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        message: state.message,
        maintenanceMode: true,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
