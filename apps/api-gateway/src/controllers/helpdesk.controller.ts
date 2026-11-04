import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  AddTicketCommentDto,
  CreateMyTicketDto,
  GetTicketsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  UpdateTicketDto,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, PermissionsGuard, RequireModule, RequirePermissions, RolesGuard, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * The helpdesk, IT's side: the queue of tickets employees raised, and
 * working them. Reading needs `tickets.view`; taking, answering, changing
 * and resolving needs `tickets.manage`.
 */
@Controller('organization/tickets')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_ASSETS)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.TICKETS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class HelpdeskController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @RequirePermissions('tickets.view', 'tickets.manage')
  @ApiOperation({ summary: 'The ticket queue, with counts by status. Filter by status, priority, category, assigned (ME | UNASSIGNED) or search' })
  list(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Query() query: GetTicketsQueryDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.LIST, { tenantId, userId, email, query });
  }

  @Get(':id')
  @RequirePermissions('tickets.view', 'tickets.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One ticket with its whole conversation, internal notes included' })
  get(@Headers('x-tenant-id') tenantId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.GET, { tenantId, id });
  }

  @Patch(':id')
  @RequireModule(HRMSModuleKey.TICKETS, ModuleAction.EDIT)
  @RequirePermissions('tickets.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Work a ticket: assign it, change status or priority, resolve it (a resolution note is needed)' })
  update(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTicketDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.UPDATE, { tenantId, userId, email, id, dto });
  }

  @Post(':id/comments')
  @RequireModule(HRMSModuleKey.TICKETS, ModuleAction.EDIT)
  @RequirePermissions('tickets.manage')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Reply to the requester, or leave an internal note (internal: true) only IT sees' })
  comment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTicketCommentDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.COMMENT, { tenantId, userId, email, id, dto });
  }
}

/**
 * The employee's own tickets. Like the rest of `organization/me`, there is no
 * permission to check: a ticket that is not yours is simply not found.
 */
@Controller('organization/me/tickets')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_ASSETS)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.TICKETS)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyTicketsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  @Get()
  @ApiOperation({ summary: 'My tickets, newest first, with how many are still open' })
  list(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_LIST, { tenantId, userId, email });
  }

  @Post()
  @ApiOperation({ summary: 'Raise a ticket with IT' })
  create(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Body() dto: CreateMyTicketDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_CREATE, { tenantId, userId, email, dto });
  }

  @Get(':id')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'One of my tickets with its conversation (internal notes are not shown)' })
  get(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_GET, { tenantId, userId, email, id });
  }

  @Post(':id/comments')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Add a reply to my ticket. A reply to a question from IT puts it back in work' })
  comment(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTicketCommentDto) {
    // Only IT writes internal notes.
    const { internal: _ignored, ...reply } = dto;
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_COMMENT, { tenantId, userId, email, id, dto: reply });
  }

  @Post(':id/reopen')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Not fixed: take a resolved ticket back into work' })
  reopen(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_REOPEN, { tenantId, userId, email, id });
  }

  @Post(':id/close')
  @ApiParam({ name: 'id' })
  @ApiOperation({ summary: 'Close my ticket: accept the fix, or withdraw it' })
  close(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.HELPDESK.MY_CLOSE, { tenantId, userId, email, id });
  }
}
