import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op } from 'sequelize';
import {
  AiConversationOwnerDto,
  AiConversationRefDto,
  LogAiFailureDto,
  SaveAiConversationDto,
} from '@app/common';
import { AiConversation } from '../models';
import { AuditService } from './audit.service';

const DEFAULT_RETENTION_DAYS = 90;

/** Conversation history for the AI Assistant, plus the audit entry for every question asked. */
@Injectable()
export class AiConversationService {
  constructor(
    @InjectModel(AiConversation) private readonly conversationModel: typeof AiConversation,
    private readonly auditService: AuditService,
  ) {}

  private retentionCutoff(): Date {
    const days = Number(process.env.AI_HISTORY_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    return new Date(Date.now() - days * 86400000);
  }

  private async findOwn({ conversationId, ownerId, ownerType }: AiConversationRefDto): Promise<AiConversation> {
    const conversation = await this.conversationModel.findOne({
      where: { id: conversationId, ownerId, ownerType },
    });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  async list({ ownerId, ownerType }: AiConversationOwnerDto) {
    // Retention is enforced lazily, per owner, whenever the history is opened.
    await this.conversationModel.destroy({
      where: { ownerId, ownerType, updatedAt: { [Op.lt]: this.retentionCutoff() } },
    });

    const rows = await this.conversationModel.findAll({
      where: { ownerId, ownerType },
      attributes: ['id', 'title', 'createdAt', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
      limit: 50,
    });
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  }

  async get(ref: AiConversationRefDto) {
    const conversation = await this.findOwn(ref);
    return {
      id: conversation.id,
      title: conversation.title,
      apiMessages: conversation.apiMessages,
      transcript: conversation.transcript,
      updatedAt: conversation.updatedAt,
    };
  }

  async save(dto: SaveAiConversationDto) {
    let conversation: AiConversation;
    if (dto.conversationId) {
      conversation = await this.findOwn({
        conversationId: dto.conversationId,
        ownerId: dto.ownerId,
        ownerType: dto.ownerType,
      });
      await conversation.update({
        apiMessages: dto.apiMessages,
        transcript: dto.transcript,
        inputTokens: conversation.inputTokens + dto.usage.inputTokens,
        outputTokens: conversation.outputTokens + dto.usage.outputTokens,
      });
    } else {
      conversation = await this.conversationModel.create({
        ownerId: dto.ownerId,
        ownerType: dto.ownerType,
        tenantId: dto.tenantId ?? null,
        title: dto.title?.trim() || 'New conversation',
        apiMessages: dto.apiMessages,
        transcript: dto.transcript,
        inputTokens: dto.usage.inputTokens,
        outputTokens: dto.usage.outputTokens,
      });
    }

    await this.writeAudit(dto, conversation.id);
    return { id: conversation.id, title: conversation.title };
  }

  logFailure(dto: LogAiFailureDto) {
    return this.writeAudit(dto, null).then(() => ({ success: true }));
  }

  /** One audit entry per question: what was asked, which data it read, and the token cost. */
  private async writeAudit(dto: LogAiFailureDto, conversationId: string | null) {
    const { audit, usage } = dto;
    const tools = [...new Set(audit.tools)];
    await this.auditService.log({
      action: audit.status === 'Success' ? 'AI_ASSISTANT_QUERY' : 'AI_ASSISTANT_QUERY_FAILED',
      actorType: dto.ownerType === 'superadmin' ? 'superadmin' : 'tenant',
      userId: dto.ownerId,
      email: audit.email,
      tenantId: dto.tenantId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
      module: 'AI Assistant',
      status: audit.status,
      actionDetails:
        `Asked: "${audit.question.slice(0, 300)}"` +
        (tools.length ? ` · Data used: ${tools.join(', ')}` : ''),
      metadata: {
        conversationId,
        tools,
        model: audit.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });
  }

  async delete(ref: AiConversationRefDto) {
    const conversation = await this.findOwn(ref);
    await conversation.destroy();
    return { success: true };
  }
}
