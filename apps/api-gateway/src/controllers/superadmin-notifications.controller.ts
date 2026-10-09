import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  MESSAGE_PATTERNS,
  PlatformNotificationListQueryDto,
  PlatformRoute,
  PushSubscriptionDto,
  PushUnsubscribeDto,
  SERVICES,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard, SuperAdminGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { IpAllowlistGuard } from '../guards/ip-allowlist.guard';

/**
 * The Super Admin's notification bell and browser push. Preferences
 * (categories, frequency, quiet hours) stay under `superadmin/profile/notifications`.
 */
@Controller('superadmin/notifications')
@PlatformRoute()
// The Security tab's IP allowlist covers the whole Super Admin portal, this included.
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, SuperAdminGuard, IpAllowlistGuard)
@Roles('superadmin')
@ApiBearerAuth()
@ApiTags(TAGS.SA_PROFILE)
export class SuperAdminNotificationsController {
  constructor(@Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'My notifications (newest first), unread count, and whether quiet hours are on now' })
  list(@CurrentUser('id') superAdminId: string, @Query() query: PlatformNotificationListQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.LIST, { superAdminId, limit: query.limit });
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(@CurrentUser('id') superAdminId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.MARK_READ, { superAdminId, id });
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark every notification read' })
  markAllRead(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.MARK_ALL_READ, { superAdminId });
  }

  @Get('push/config')
  @ApiOperation({ summary: "Whether browser push is available, and the VAPID public key browsers subscribe with" })
  pushConfig() {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.PUSH_CONFIG, {});
  }

  @Post('push/subscriptions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Turn on browser push for this browser (send PushSubscription.toJSON())' })
  subscribe(
    @CurrentUser('id') superAdminId: string,
    @Body() subscription: PushSubscriptionDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.PUSH_SUBSCRIBE, {
      superAdminId,
      subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      userAgent: userAgent?.slice(0, 500),
    });
  }

  @Delete('push/subscriptions')
  @ApiOperation({ summary: 'Turn off browser push for one browser' })
  unsubscribe(@CurrentUser('id') superAdminId: string, @Body() dto: PushUnsubscribeDto) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.PUSH_UNSUBSCRIBE, { superAdminId, endpoint: dto.endpoint });
  }

  @Post('push/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a test notification to every browser I turned push on in' })
  sendTest(@CurrentUser('id') superAdminId: string) {
    return this.authClient.send(MESSAGE_PATTERNS.PLATFORM_NOTIFICATIONS.PUSH_TEST, { superAdminId });
  }
}
