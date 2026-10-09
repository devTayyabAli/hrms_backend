import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';

/** Every organization data export in the API ends in /export. */
const EXPORT_PATH = /\/export\/?$/;
/** The platform's own exports (audit logs, reports) are the Super Admin's, not organizations' data. */
const PLATFORM_PATH = /\/superadmin(\/|$)/;

/**
 * Enforces System Management › General › "Allow users to export data": when
 * it's off, organizations' export endpoints refuse with 403 for everyone in
 * them. The flag is read through a one-minute cache (and dropped the moment
 * General settings are saved), so the check costs nothing on most requests.
 *
 * Fails open on a lookup error: exports are a convenience, and an auth-service
 * blip must not read as "your administrator turned this off".
 */
@Injectable()
export class ExportPolicyGuard implements CanActivate {
  private readonly logger = new Logger(ExportPolicyGuard.name);
  private cached: { allowed: boolean; at: number } | null = null;
  private static instance: ExportPolicyGuard | null = null;

  constructor(@Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy) {
    ExportPolicyGuard.instance = this;
  }

  static invalidateAll(): void {
    if (ExportPolicyGuard.instance) ExportPolicyGuard.instance.cached = null;
  }

  private async exportsAllowed(): Promise<boolean> {
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.allowed;
    try {
      const settings: any = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.SETTINGS.GET_GENERAL, {}).pipe(timeout(3000)),
      );
      const allowed = settings?.allowUsersToExportData !== false;
      this.cached = { allowed, at: Date.now() };
      return allowed;
    } catch (error: any) {
      this.logger.warn(`Export policy unavailable, allowing: ${error?.message ?? error}`);
      return true;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest();
    const path: string = request.path || '';
    if (!EXPORT_PATH.test(path) || PLATFORM_PATH.test(path)) return true;
    if (await this.exportsAllowed()) return true;
    throw new ForbiddenException('Data export has been turned off by the platform administrator.');
  }
}
