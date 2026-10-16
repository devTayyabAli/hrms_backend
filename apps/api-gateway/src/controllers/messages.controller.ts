import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  GetChatContactsQueryDto,
  GetChatMessagesQueryDto,
  GetConversationsQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  SendChatMessageDto,
  StartConversationDto,
} from '@app/common';
import {
  CurrentUser,
  JwtAuthGuard,
  OrganizationModuleGuard,
  PermissionsGuard,
  RequireModule,
  RequirePermissions,
  RolesGuard,
  TenantGuard,
} from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { sendFileResponse } from '../utils/file-response.helper';
import { resolveOwnFile } from '../utils/chat-attachment';
import { ChatRealtimeService } from '../realtime/chat-realtime.service';

/**
 * Messages (organization portal): one-to-one conversations between people in
 * the organization — the Recent Conversations list, a conversation's
 * messages, sending text and files, read receipts, presence and unread counts.
 *
 * Everything is the caller's own: a conversation is only ever visible to its
 * two people. Live updates come over the socket (see realtime/chat.gateway.ts);
 * the REST endpoints stay the source of truth and the fallback: the screen can poll `messages?after=` for the
 * open conversation and `conversations` / `unread` for the list and badge.
 *
 * Files are uploaded with `POST /files/upload` (category "chat") first, then
 * attached to a message by `fileId`.
 */
@Controller('organization/messages')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_MESSAGES)
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, PermissionsGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.NOTIFICATIONS)
@ApiHeader({ name: 'x-tenant-id', description: 'Target Organization Tenant ID', required: true })
export class MessagesController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly realtime: ChatRealtimeService,
  ) {}

  /** Who is asking — the tenant from the guarded header and the login from the token. */
  private caller(tenantId: string, userId: string, email?: string) {
    return { tenantId, userId, email };
  }

  // Static routes are declared before the `:conversationId` ones so they are never read as an id.

  @Get('conversations')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiOperation({ summary: 'Recent Conversations — newest first, with the other person, last message and unread count' })
  getConversations(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetConversationsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_CONVERSATIONS, { ...this.caller(tenantId, userId, email), query });
  }

  @Post('conversations')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.CREATE)
  @RequirePermissions('messages.create', 'messages.manage')
  @ApiOperation({ summary: 'Start a conversation with an employee — or get the one that already exists' })
  startConversation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: StartConversationDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.START_CONVERSATION, { ...this.caller(tenantId, userId, email), dto });
  }

  @Get('contacts')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.CREATE)
  @RequirePermissions('messages.create', 'messages.manage')
  @ApiOperation({ summary: 'People to start a conversation with (current employees), searchable' })
  getContacts(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetChatContactsQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_CONTACTS, { ...this.caller(tenantId, userId, email), query });
  }

  @Get('unread')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiOperation({ summary: 'Unread conversations and messages, for the sidebar badge' })
  getUnread(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_UNREAD, this.caller(tenantId, userId, email));
  }

  @Post('presence')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiOperation({ summary: 'Heartbeat: "I am here". Send it about once a minute while Messages is open' })
  heartbeat(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.HEARTBEAT, this.caller(tenantId, userId, email));
  }

  @Get('attachments/:messageId')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiParam({ name: 'messageId' })
  @ApiOperation({ summary: 'Download a message\'s attachment — only for the two people in the conversation' })
  async downloadAttachment(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Res() res: Response,
  ) {
    const attachment: { fileId: string } = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_ATTACHMENT, { ...this.caller(tenantId, userId, email), messageId }),
    );
    const file: any = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, { fileId: attachment.fileId, userTenantId: tenantId }),
    );
    if (file && file.buffer) return sendFileResponse(res, file, true);
    return res.status(404).json({ message: 'File stream unavailable.' });
  }

  @Get('conversations/:conversationId')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiParam({ name: 'conversationId' })
  @ApiOperation({ summary: 'One conversation: who it is with, whether they are online, and the unread count' })
  getConversation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_CONVERSATION, { ...this.caller(tenantId, userId, email), conversationId });
  }

  @Delete('conversations/:conversationId')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiParam({ name: 'conversationId' })
  @ApiOperation({ summary: 'Delete the conversation from your own list. The other person keeps theirs' })
  deleteConversation(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.DELETE_CONVERSATION, { ...this.caller(tenantId, userId, email), conversationId });
  }

  @Get('conversations/:conversationId/messages')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiParam({ name: 'conversationId' })
  @ApiOperation({ summary: 'A page of messages, oldest first. `before` pages back, `after` returns only newer ones (polling)' })
  getMessages(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Query() query: GetChatMessagesQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GET_MESSAGES, { ...this.caller(tenantId, userId, email), conversationId, query });
  }

  @Post('conversations/:conversationId/messages')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.CREATE)
  @RequirePermissions('messages.create', 'messages.manage')
  @ApiParam({ name: 'conversationId' })
  @ApiOperation({ summary: 'Send a message: text, a file (fileId from POST /files/upload), or both' })
  async sendMessage(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendChatMessageDto,
  ) {
    const attachment = dto.fileId ? await resolveOwnFile(this.authClient, tenantId, userId, dto.fileId) : undefined;
    const caller = this.caller(tenantId, userId, email);
    const message = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.CHAT.SEND_MESSAGE, { ...caller, conversationId, dto, attachment }),
    );
    // Whoever has the conversation open gets it now, without waiting for their next poll.
    void this.realtime.publishMessage(caller, conversationId, message);
    return message;
  }

  @Post('conversations/:conversationId/read')
  @RequireModule(HRMSModuleKey.NOTIFICATIONS, ModuleAction.VIEW)
  @RequirePermissions('messages.view', 'messages.manage')
  @ApiParam({ name: 'conversationId' })
  @ApiOperation({ summary: 'Mark the conversation read — the other person then sees their messages as seen' })
  async markRead(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    const caller = this.caller(tenantId, userId, email);
    const result: any = await firstValueFrom(this.tenantClient.send(MESSAGE_PATTERNS.CHAT.MARK_READ, { ...caller, conversationId }));
    void this.realtime.publishRead(caller, conversationId, result.readAt);
    return result;
  }
}
