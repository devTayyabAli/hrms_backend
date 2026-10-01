import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { Public, SERVICES, MESSAGE_PATTERNS } from '@app/common';
import { firstValueFrom, timeout } from 'rxjs';
import { JwtAuthGuard, RolesGuard, SuperAdminGuard, Roles } from '@app/tenant-context';

@Controller('health')
export class ApiGatewayHealthController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) {}

  private async checkService(client: ClientProxy, name: string) {
    try {
      const res = await firstValueFrom(
        client.send(MESSAGE_PATTERNS.HEALTH.CHECK, {}).pipe(timeout(3000)),
      );
      return res || { service: name, status: 'up' };
    } catch (err: any) {
      return { service: name, status: 'down', error: err.message };
    }
  }

  /**
   * Public liveness probe. Deliberately generic — no service names, ports,
   * or per-microservice status, which would hand an unauthenticated caller
   * a map of the internal architecture. Use /health/detailed for that.
   */
  @ApiTags(TAGS.PLATFORM_HEALTH)
  @Get()
  @Public()
  @ApiOperation({ summary: 'Basic liveness probe (no internal architecture details)' })
  async checkHealth() {
    return { status: 'ok' };
  }

  /**
   * Detailed per-microservice health, gated to SuperAdmins only.
   */
  @ApiTags(TAGS.SA_SYSTEM)
  @Get('detailed')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, SuperAdminGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'SuperAdmin: Detailed API Gateway & Microservices Health Breakdown' })
  async checkHealthDetailed() {
    const [authHealth, tenantHealth, userHealth] = await Promise.all([
      this.checkService(this.authClient, 'auth-service'),
      this.checkService(this.tenantClient, 'tenant-service'),
      this.checkService(this.userClient, 'user-service'),
    ]);

    return {
      service: 'api-gateway',
      status: 'up',
      timestamp: new Date().toISOString(),
      microservices: {
        auth: authHealth,
        tenant: tenantHealth,
        user: userHealth,
      },
    };
  }
}
