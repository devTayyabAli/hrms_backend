import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AiChatDto, PlatformRoute } from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  Roles,
  SuperAdminGuard,
  CurrentUser,
} from '@app/tenant-context';
import { IpAllowlistGuard } from '../guards/ip-allowlist.guard';
import { TAGS } from '../swagger/swagger-tags';
import { AiAssistantService, AiOwner, AiStreamEvent } from '../ai-assistant/ai-assistant.service';
import { SUPERADMIN_TOOLS } from '../ai-assistant/superadmin-tools';

/**
 * Phase 1 of the AI Assistant: the Super Admin asks questions about the whole
 * platform. Same guard stack as SuperAdminController, so the assistant can
 * never be reached by anyone who couldn't open the Super Admin portal, and it
 * lives under `/superadmin` so maintenance mode doesn't lock it out.
 */
@ApiTags(TAGS.SA_DASHBOARD)
@ApiBearerAuth()
@Controller('superadmin/ai')
@PlatformRoute()
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard, SuperAdminGuard, IpAllowlistGuard)
@Roles('superadmin')
export class SuperAdminAiController {
  constructor(private readonly aiAssistant: AiAssistantService) {}

  private owner(id: string, email?: string): AiOwner {
    return { ownerId: id, ownerType: 'superadmin', email };
  }

  @Post('chat')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary:
      'SuperAdmin AI Assistant: ask a question about the platform. Streams Server-Sent Events: ' +
      '`text` (answer deltas), `tool` (data being read), `done` (conversationId) or `error`.',
  })
  async chat(
    @Body() dto: AiChatDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const owner = this.owner(userId, email);
    // Loaded before the stream opens, so an unknown conversation is a plain 404.
    const prior = await this.aiAssistant.prepare(owner, dto.conversationId);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const emit = (e: AiStreamEvent) => {
      if (!res.writableEnded) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };

    await this.aiAssistant.chat(
      {
        owner,
        audience: 'the platform Super Admin, who manages every organization, subscription and the platform itself',
        tools: SUPERADMIN_TOOLS,
        message: dto.message,
        conversationId: dto.conversationId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        emit,
        signal: abort.signal,
      },
      prior,
    );
    if (!res.writableEnded) res.end();
  }

  @Get('conversations')
  @ApiOperation({ summary: 'SuperAdmin AI Assistant: my recent conversations (kept 90 days)' })
  listConversations(@CurrentUser('id') userId: string) {
    return this.aiAssistant.listConversations(this.owner(userId));
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'SuperAdmin AI Assistant: one conversation transcript' })
  getConversation(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.aiAssistant.getConversation(this.owner(userId), id);
  }

  @Delete('conversations/:id')
  @ApiOperation({ summary: 'SuperAdmin AI Assistant: delete a conversation' })
  deleteConversation(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.aiAssistant.deleteConversation(this.owner(userId), id);
  }
}
