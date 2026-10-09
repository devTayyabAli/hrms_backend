import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { Throttle } from '@nestjs/throttler';
import { firstValueFrom } from 'rxjs';
import {
  CreateSupportTicketDto,
  GetArticlesQueryDto,
  GetSupportTicketsQueryDto,
  GetVideosQueryDto,
  MESSAGE_PATTERNS,
  SERVICES,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/** "org_admin" → "Org Admin". */
const roleLabel = (role?: string) =>
  role
    ? role.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

/**
 * The Help centre for organization users (admins, HR, employees): read the
 * platform's articles and video tutorials, raise support tickets with the
 * platform team, and follow their own tickets. Managing content and answering
 * tickets is the Super Admin's side (`superadmin/help/*`).
 */
@Controller('organization/help')
@UseGuards(JwtAuthGuard, TenantGuard)
@ApiBearerAuth()
@ApiTags(TAGS.ORG_AUTH)
export class OrganizationHelpController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary:
      'Help topics with article counts, outside help links and the support email',
  })
  async overview() {
    const overview: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.HELP.GET_OVERVIEW, {}),
    );
    return {
      categories: overview?.categories ?? [],
      // Internal links point into the Super Admin portal; organizations get external ones only.
      resourceLinks: (overview?.resourceLinks ?? []).filter(
        (link: any) => link.url && !String(link.url).startsWith('/'),
      ),
      supportEmail: overview?.supportEmail ?? null,
    };
  }

  @Get('articles')
  @ApiOperation({
    summary:
      'Published help articles (All / Trending / New, by topic, searchable)',
  })
  listArticles(@Query() query: GetArticlesQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_ARTICLES, query);
  }

  @Get('articles/:id')
  @ApiOperation({ summary: 'Read an article (counts a view)' })
  getArticle(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_ARTICLE, { id });
  }

  @Get('videos')
  @ApiOperation({ summary: 'Published video tutorials' })
  listVideos(@Query() query: GetVideosQueryDto) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_VIDEOS, query);
  }

  @Get('videos/:id')
  @ApiOperation({ summary: 'Open a video tutorial (counts a view)' })
  getVideo(@Param('id') id: string) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.GET_VIDEO, { id });
  }

  @Get('tickets')
  @ApiOperation({ summary: "The caller's own support tickets" })
  @ApiQuery({ name: 'status', required: false })
  listMyTickets(
    @Query() query: GetSupportTicketsQueryDto,
    @CurrentUser() user: any,
  ) {
    // Scoped to the caller whatever the query says.
    return this.authClient.send(MESSAGE_PATTERNS.HELP.LIST_TICKETS, {
      ...query,
      createdBy: user?.id || user?.sub,
    });
  }

  @Get('tickets/:id')
  @ApiOperation({ summary: "One of the caller's own support tickets" })
  async getMyTicket(@Param('id') id: string, @CurrentUser() user: any) {
    const ticket: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.HELP.GET_TICKET, { id }),
    );
    if (!ticket || ticket.createdBy !== (user?.id || user?.sub))
      throw new NotFoundException('This ticket no longer exists.');
    return ticket;
  }

  @Post('tickets')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Raise a support ticket with the platform team' })
  createTicket(@Body() dto: CreateSupportTicketDto, @CurrentUser() user: any) {
    return this.authClient.send(MESSAGE_PATTERNS.HELP.CREATE_TICKET, {
      dto,
      createdBy: user?.id || user?.sub,
      createdByEmail: user?.email,
      createdByRole: roleLabel(user?.role),
      tenantId: user?.tenantId,
    });
  }
}
