import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import Anthropic from '@anthropic-ai/sdk';
import { MESSAGE_PATTERNS, SERVICES, AiOwnerType } from '@app/common';
import { toToolResultText } from './ai-data-guard';
import { AiTool, AiToolContext, toApiTools, validateToolInput } from './superadmin-tools';

/** Server-side refusal fallback: routes a declined turn to a suitable model automatically. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Model calls allowed for one question (each may run several tools in parallel). */
const MAX_MODEL_CALLS = 10;
/** History beyond this is refused rather than sent; the user starts a new conversation. */
const MAX_HISTORY_CHARS = 1_500_000;
const MAX_TITLE_LENGTH = 80;

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiOwner {
  ownerId: string;
  ownerType: AiOwnerType;
  tenantId?: string;
  email?: string;
}

export interface AiTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  /** Data sources the answer used (assistant entries only). */
  sources?: { name: string; label: string }[];
  status?: 'complete' | 'incomplete' | 'refused';
  at: string;
}

export type AiStreamEvent =
  | { event: 'text'; data: { delta: string } }
  | { event: 'tool'; data: { id: string; name: string; label: string; status: 'running' | 'done' | 'error' } }
  | { event: 'done'; data: { conversationId: string; title: string; status: AiTranscriptEntry['status'] } }
  | { event: 'error'; data: { message: string } };

export interface AiChatRequest {
  owner: AiOwner;
  /** Who the assistant is talking to; shapes the system prompt. */
  audience: string;
  tools: AiTool[];
  message: string;
  conversationId?: string;
  ipAddress?: string;
  userAgent?: string;
  emit: (e: AiStreamEvent) => void;
  signal: AbortSignal;
}

interface StoredConversation {
  id: string;
  title: string;
  apiMessages: Anthropic.Beta.BetaMessageParam[];
  transcript: AiTranscriptEntry[];
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The system prompt is identical for every request on a given day, so the
 * tools + system prefix stays cacheable across questions and users.
 */
const buildSystemPrompt = (audience: string): string => `You are the AI Assistant inside Fuutura HRMS, a multi-tenant HR management platform. You are talking to ${audience}.

Today is ${dayFormat.format(new Date())}. Use ISO dates (YYYY-MM-DD) in tool filters.

How to answer:
- Base every number, name and fact on tool results from this conversation. Call the tools you need before answering; if the tools don't provide something, say you don't have that data. Never estimate or invent figures.
- Prefer the narrowest tool and filters that answer the question. Lists come back at most 50 rows at a time; use filters or paging rather than guessing about rows you didn't see.
- Fields shown as "[redacted]" are withheld on purpose. Don't guess or reconstruct them.
- You can only read data. If asked to change something (activate an organization, edit a plan, etc.), say where in the app that is done instead.
- Reply in the same language and script the user writes in: English, Urdu, or Roman Urdu.

Format:
- Lead with the direct answer in one or two sentences, then the supporting detail. Keep it concise.
- Use Markdown: short paragraphs, bullet lists, and tables for tabular data (up to 20 rows; mention how many more exist).
- When a chart makes the answer clearer (trends over time, shares of a whole, comparisons), add one fenced block with the language "chart" containing JSON:
  {"type":"bar"|"line"|"pie"|"doughnut","title":"…","labels":["…"],"series":[{"label":"…","values":[1,2,3]}]}
  Every series must have one numeric value per label. Pie and doughnut charts take exactly one series. Use at most one chart per answer unless asked for more.
- Show money exactly as the tools return it, with its currency if given; don't convert currencies.`;

@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger(AiAssistantService.name);
  private client: Anthropic | null = null;

  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) {}

  private get model(): string {
    return process.env.AI_ASSISTANT_MODEL || 'claude-opus-5-5';
  }

  private get effort(): Effort {
    const effort = process.env.AI_ASSISTANT_EFFORT as Effort;
    return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'medium';
  }

  /** Credentials resolve from ANTHROPIC_API_KEY (or the SDK's other sources) on first use. */
  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ maxRetries: 2 });
    return this.client;
  }

  // ==========================================
  // HISTORY
  // ==========================================

  listConversations(owner: AiOwner) {
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AI_ASSISTANT.LIST_CONVERSATIONS, {
        ownerId: owner.ownerId,
        ownerType: owner.ownerType,
      }),
    );
  }

  /** The display transcript only — the raw model history never leaves the backend. */
  async getConversation(owner: AiOwner, conversationId: string) {
    const conversation = await this.loadConversation(owner, conversationId);
    return { id: conversation.id, title: conversation.title, transcript: conversation.transcript };
  }

  deleteConversation(owner: AiOwner, conversationId: string) {
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AI_ASSISTANT.DELETE_CONVERSATION, {
        conversationId,
        ownerId: owner.ownerId,
        ownerType: owner.ownerType,
      }),
    );
  }

  private loadConversation(owner: AiOwner, conversationId: string): Promise<StoredConversation> {
    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AI_ASSISTANT.GET_CONVERSATION, {
        conversationId,
        ownerId: owner.ownerId,
        ownerType: owner.ownerType,
      }),
    );
  }

  /**
   * Loads what a chat turn needs before the response starts streaming, so a
   * missing conversation still surfaces as a normal 404.
   */
  async prepare(owner: AiOwner, conversationId?: string): Promise<StoredConversation | null> {
    if (!conversationId) return null;
    const conversation = await this.loadConversation(owner, conversationId);
    if (JSON.stringify(conversation.apiMessages).length > MAX_HISTORY_CHARS) {
      throw new ServiceUnavailableException('This conversation is too long to continue. Please start a new one.');
    }
    return conversation;
  }

  // ==========================================
  // CHAT TURN
  // ==========================================

  async chat(req: AiChatRequest, prior: StoredConversation | null): Promise<void> {
    const { emit, signal } = req;
    const toolsByName = new Map(req.tools.map((t) => [t.name, t]));
    const ctx: AiToolContext = {
      authClient: this.authClient,
      tenantClient: this.tenantClient,
      userClient: this.userClient,
    };

    // History is append-only: earlier turns are sent back exactly as the model
    // produced them (thinking blocks included), never edited or trimmed.
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      ...(prior?.apiMessages ?? []),
      { role: 'user', content: req.message },
    ];

    const usage = { inputTokens: 0, outputTokens: 0 };
    const sources = new Map<string, { name: string; label: string }>();
    let answer = '';
    let status: AiTranscriptEntry['status'] = 'complete';

    try {
      let calls = 0;
      while (true) {
        if (calls++ >= MAX_MODEL_CALLS) {
          status = 'incomplete';
          const note = '\n\n_I needed more steps than allowed to finish this. Try a narrower question._';
          answer += note;
          emit({ event: 'text', data: { delta: note } });
          break;
        }

        const stream = this.getClient().beta.messages.stream(
          {
            model: this.model,
            max_tokens: 16000,
            system: buildSystemPrompt(req.audience),
            tools: toApiTools(req.tools),
            messages,
            thinking: { type: 'adaptive' },
            output_config: { effort: this.effort },
            cache_control: { type: 'ephemeral' },
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
          },
          { signal },
        );
        stream.on('text', (delta) => {
          answer += delta;
          emit({ event: 'text', data: { delta } });
        });

        const message = await stream.finalMessage();
        usage.inputTokens +=
          (message.usage.input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0);
        usage.outputTokens += message.usage.output_tokens ?? 0;

        messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

        if (message.stop_reason === 'refusal') {
          status = 'refused';
          if (!answer.trim()) {
            answer = "I can't help with that request.";
            emit({ event: 'text', data: { delta: answer } });
          }
          break;
        }

        const toolUses = message.content.filter(
          (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
        );
        if (toolUses.length === 0) {
          if (message.stop_reason === 'max_tokens') status = 'incomplete';
          break;
        }
        if (message.stop_reason === 'max_tokens') {
          // A tool input cut off mid-way can still parse; never run it.
          status = 'incomplete';
          break;
        }

        // Run this turn's tool calls together and answer them in one message.
        const results = await Promise.all(
          toolUses.map((use) => this.runTool(use, toolsByName.get(use.name), ctx, emit, sources)),
        );
        messages.push({ role: 'user', content: results });
      }
    } catch (error) {
      if (signal.aborted) return; // the reader closed the panel; nothing to save or send
      this.logger.error(`AI chat failed: ${error instanceof Error ? error.message : error}`);
      emit({ event: 'error', data: { message: this.describeError(error) } });
      await this.auditFailure(req, usage, [...sources.keys()]);
      return;
    }

    const now = new Date().toISOString();
    const transcript: AiTranscriptEntry[] = [
      ...(prior?.transcript ?? []),
      { role: 'user', text: req.message, at: now },
      { role: 'assistant', text: answer.trim(), sources: [...sources.values()], status, at: now },
    ];

    try {
      const saved: { id: string; title: string } = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.AI_ASSISTANT.SAVE_CONVERSATION, {
          conversationId: prior?.id,
          ownerId: req.owner.ownerId,
          ownerType: req.owner.ownerType,
          tenantId: req.owner.tenantId,
          title: prior?.title ?? this.titleFor(req.message),
          apiMessages: messages,
          transcript,
          usage,
          audit: this.auditPayload(req, [...sources.keys()], 'Success'),
        }),
      );
      emit({ event: 'done', data: { conversationId: saved.id, title: saved.title, status } });
    } catch (error) {
      this.logger.error(`Saving AI conversation failed: ${error instanceof Error ? error.message : error}`);
      emit({ event: 'error', data: { message: 'The answer was shown but could not be saved to your history.' } });
    }
  }

  private async runTool(
    use: Anthropic.Beta.BetaToolUseBlock,
    tool: AiTool | undefined,
    ctx: AiToolContext,
    emit: AiChatRequest['emit'],
    sources: Map<string, { name: string; label: string }>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    if (!tool) {
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool "${use.name}".` };
    }

    emit({ event: 'tool', data: { id: use.id, name: tool.name, label: tool.label, status: 'running' } });
    const parsed = validateToolInput(tool, use.input);
    if (parsed.ok === false) {
      emit({ event: 'tool', data: { id: use.id, name: tool.name, label: tool.label, status: 'error' } });
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Invalid input: ${parsed.error}` };
    }

    try {
      const data = await tool.run(parsed.value, ctx);
      sources.set(tool.name, { name: tool.name, label: tool.label });
      emit({ event: 'tool', data: { id: use.id, name: tool.name, label: tool.label, status: 'done' } });
      return { type: 'tool_result', tool_use_id: use.id, content: toToolResultText(data) };
    } catch (error) {
      emit({ event: 'tool', data: { id: use.id, name: tool.name, label: tool.label, status: 'error' } });
      const reason = (error as { message?: string })?.message || 'The data service did not respond.';
      return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Could not load data: ${reason}` };
    }
  }

  private titleFor(question: string): string {
    const oneLine = question.replace(/\s+/g, ' ').trim();
    return oneLine.length > MAX_TITLE_LENGTH ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…` : oneLine;
  }

  private auditPayload(req: AiChatRequest, tools: string[], status: 'Success' | 'Failed') {
    return {
      question: req.message.slice(0, 1000),
      tools,
      status,
      email: req.owner.email,
      ipAddress: req.ipAddress,
      userAgent: req.userAgent,
      model: this.model,
    };
  }

  /**
   * A failed turn still leaves an audit entry. The conversation itself is not
   * written: its history may end mid-tool-call, which can't be continued.
   */
  private async auditFailure(
    req: AiChatRequest,
    usage: { inputTokens: number; outputTokens: number },
    tools: string[],
  ) {
    try {
      await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.AI_ASSISTANT.LOG_FAILURE, {
          ownerId: req.owner.ownerId,
          ownerType: req.owner.ownerType,
          tenantId: req.owner.tenantId,
          usage,
          audit: this.auditPayload(req, tools, 'Failed'),
        }),
      );
    } catch {
      // Auditing a failure must never mask the original error.
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return 'The AI Assistant is not configured correctly (API key missing or invalid). Ask your administrator to check ANTHROPIC_API_KEY.';
    }
    if (error instanceof Anthropic.RateLimitError) {
      return 'The AI Assistant is busy right now. Please try again in a minute.';
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return 'Could not reach the AI service. Check the server’s internet connection and try again.';
    }
    if (error instanceof Anthropic.APIError) {
      return 'The AI service returned an error. Please try again.';
    }
    return 'Something went wrong while answering. Please try again.';
  }
}
