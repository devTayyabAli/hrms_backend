import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, QueryTypes, UniqueConstraintError } from 'sequelize';
import {
  CHAT_BODY_MAX,
  ChatAttachmentDto,
  ChatCallerDto,
  EmployeeStatus,
  GetChatContactsQueryDto,
  GetChatMessagesQueryDto,
  GetConversationsQueryDto,
  SendChatMessageDto,
  StartConversationDto,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { TenantService } from './tenant.service';

/** Seen this recently counts as online. The heartbeat and every chat call refresh it. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;
/** Writing presence on every poll would be a write per call; once in a while is enough. */
const PRESENCE_WRITE_EVERY_MS = 20 * 1000;
const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_MAX = 120;
/** Searching a conversation's text looks through at most this many hits. */
const SEARCH_HIT_CAP = 500;

/** The signed-in person, as the conversations know them. */
export interface ChatIdentity {
  userId: string;
  employeeId: string | null;
  name: string;
  /** Only set for someone without an employee record: "Organization Admin". */
  title: string | null;
}

export interface ChatCounterpart {
  /** Employee id when they are an employee. */
  employeeId: string | null;
  name: string;
  avatarUrl: string | null;
  /** "HR Manager" */
  designation: string | null;
  department: string | null;
  online: boolean;
  lastSeenAt: string | null;
}

export interface ConversationRow {
  id: string;
  counterpart: ChatCounterpart;
  lastMessage: { preview: string; sentAt: Date; fromMe: boolean; hasAttachment: boolean } | null;
  unreadCount: number;
  updatedAt: Date;
}

export interface ChatMessageRow {
  id: string;
  conversationId: string;
  fromMe: boolean;
  body: string | null;
  attachment: {
    name: string;
    mimeType: string | null;
    sizeBytes: number;
    sizeLabel: string;
    /** Relative to the API root; download with the same headers as any other call. */
    downloadPath: string;
  } | null;
  sentAt: Date;
  /** Only on your own messages: SEEN once the other person has opened the conversation after it was sent. */
  status: 'SENT' | 'SEEN' | null;
  seenAt: Date | null;
}

const sizeLabel = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toString()} MB`;
};

/** "sara.khan@example.com" -> "Sara Khan" — all a login with no employee record gives us. */
const nameFromEmail = (email?: string) =>
  (email?.split('@')[0] ?? 'Someone')
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ') || 'Someone';

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Messages: one-to-one conversations between people in the organization.
 *
 * A conversation has two participants; each keeps their own read position and
 * can delete the conversation from their own list without touching the other
 * person's copy. "Seen" is just the other participant's read position, and
 * "Online" is a heartbeat — there is no socket, the screen polls.
 *
 * People are identified by employee id where they have one, and by login
 * otherwise: the organization admin has no employee record but has to be able
 * to talk to the people they run.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly tenantService: TenantService,
  ) {}

  // ==========================================
  // Errors
  // ==========================================

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private notFound(): never {
    this.fail(HttpStatus.NOT_FOUND, 'Conversation not found.');
  }

  // ==========================================
  // Who is asking
  // ==========================================

  /** The caller's employee record, found the way the employee portal finds "me": login id first, then email. */
  private async identify(caller: ChatCallerDto): Promise<ChatIdentity> {
    const { tenantId, userId, email } = caller;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const attributes = ['id', 'firstName', 'lastName'];

    let employee: any = UUID.test(userId) ? await Employee.findOne({ where: { tenantId, userId }, attributes }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes });
    }
    if (employee) {
      return {
        userId,
        employeeId: employee.id,
        name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
        title: null,
      };
    }

    // No employee record: the organization admin. Their name is on the organization.
    let name = nameFromEmail(email);
    let title: string | null = null;
    try {
      const tenant: any = await this.tenantService.getTenantById(tenantId);
      if (email && tenant?.adminEmail?.toLowerCase() === email.toLowerCase()) {
        name = tenant.adminName || name;
        title = 'Organization Admin';
      }
    } catch (error: any) {
      this.logger.warn(`Could not read the organization to name ${userId}: ${error?.message ?? error}`);
    }
    return { userId, employeeId: null, name, title };
  }

  /** Identifies the caller and records that they are here — every chat call is a sign of life. */
  private async actor(caller: ChatCallerDto): Promise<ChatIdentity> {
    const identity = await this.identify(caller);
    await this.touchPresence(caller.tenantId, identity);
    return identity;
  }

  /** Presence must never fail a conversation. */
  private async touchPresence(tenantId: string, identity: ChatIdentity) {
    try {
      const Presence = await this.modelProvider.getChatPresenceModel(tenantId);
      const now = new Date();
      const [row, created] = await Presence.findOrCreate({
        where: { userId: identity.userId },
        defaults: { tenantId, userId: identity.userId, employeeId: identity.employeeId, lastSeenAt: now } as any,
      });
      if (!created && now.getTime() - new Date(row.lastSeenAt).getTime() > PRESENCE_WRITE_EVERY_MS) {
        await row.update({ lastSeenAt: now, employeeId: identity.employeeId ?? row.employeeId });
      }
    } catch (error: any) {
      this.logger.warn(`Presence not recorded: ${error?.message ?? error}`);
    }
  }

  /** The rows that belong to this person, whichever of their two identities the row was written with. */
  private mine(identity: ChatIdentity) {
    const owners: Record<string, unknown>[] = [{ userId: identity.userId }];
    if (identity.employeeId) owners.push({ employeeId: identity.employeeId });
    return { [Op.or]: owners };
  }

  private isMine(identity: ChatIdentity, row: { senderUserId?: string | null; senderEmployeeId?: string | null }) {
    return (
      row.senderUserId === identity.userId ||
      Boolean(identity.employeeId && row.senderEmployeeId === identity.employeeId)
    );
  }

  private personKey(person: { employeeId: string | null; userId: string }) {
    return person.employeeId ? `e:${person.employeeId}` : `u:${person.userId}`;
  }

  /** The caller's participant row in this conversation, or a 404 — someone else's conversation doesn't exist for them. */
  private async myParticipant(tenantId: string, identity: ChatIdentity, conversationId: string) {
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);
    const row = await Participant.findOne({ where: { tenantId, conversationId, ...this.mine(identity) } });
    if (!row) this.notFound();
    return row;
  }

  private async otherParticipant(tenantId: string, conversationId: string, mine: any) {
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);
    const row = await Participant.findOne({ where: { tenantId, conversationId, id: { [Op.ne]: mine.id } } });
    if (!row) this.notFound();
    return row;
  }

  // ==========================================
  // Who the other person is
  // ==========================================

  /** Counterparts for many participant rows at once: their profile and whether they are online. */
  private async counterparts(tenantId: string, others: any[]): Promise<Map<string, ChatCounterpart>> {
    const result = new Map<string, ChatCounterpart>();
    if (!others.length) return result;

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Presence = await this.modelProvider.getChatPresenceModel(tenantId);

    const employeeIds = [...new Set(others.map((o) => o.employeeId).filter(Boolean))] as string[];
    const userIds = [...new Set(others.map((o) => o.userId).filter(Boolean))] as string[];

    const [employees, presences] = await Promise.all([
      employeeIds.length
        ? Employee.findAll({
            where: { tenantId, id: { [Op.in]: employeeIds } },
            attributes: ['id', 'firstName', 'lastName', 'avatarUrl'],
            include: [
              { model: Designation, as: 'designation', attributes: ['title'], required: false },
              { model: Department, as: 'department', attributes: ['name'], required: false },
            ],
          })
        : Promise.resolve([]),
      Presence.findAll({
        where: {
          tenantId,
          [Op.or]: [
            ...(userIds.length ? [{ userId: { [Op.in]: userIds } }] : []),
            ...(employeeIds.length ? [{ employeeId: { [Op.in]: employeeIds } }] : []),
          ],
        },
        attributes: ['userId', 'employeeId', 'lastSeenAt'],
      }),
    ]);

    const employeeById = new Map((employees as any[]).map((employee) => [employee.id, employee]));
    const now = Date.now();

    for (const other of others) {
      const employee: any = other.employeeId ? employeeById.get(other.employeeId) : null;
      const seen = (presences as any[])
        .filter((p) => (other.userId && p.userId === other.userId) || (other.employeeId && p.employeeId === other.employeeId))
        .map((p) => new Date(p.lastSeenAt).getTime())
        .sort((a, b) => b - a)[0];

      result.set(other.id, {
        employeeId: other.employeeId ?? null,
        name: employee ? [employee.firstName, employee.lastName].filter(Boolean).join(' ') : (other.displayName ?? 'Unknown'),
        avatarUrl: employee?.avatarUrl ?? null,
        designation: employee ? (employee.designation?.title ?? null) : (other.title ?? null),
        department: employee?.department?.name ?? null,
        online: seen !== undefined && now - seen <= ONLINE_WINDOW_MS,
        lastSeenAt: seen !== undefined ? new Date(seen).toISOString() : null,
      });
    }
    return result;
  }

  /** Messages from others after this person's read position and after they last cleared the conversation. */
  private async unreadByConversation(tenantId: string, identity: ChatIdentity, mine: any[]): Promise<Map<string, number>> {
    if (!mine.length) return new Map();
    const Message = await this.modelProvider.getChatMessageModel(tenantId);
    const rows = (await Message.sequelize!.query(
      `SELECT m."conversationId" AS "conversationId", COUNT(*)::int AS "count"
         FROM chat_messages m
         JOIN chat_participants p ON p."conversationId" = m."conversationId"
        WHERE p.id IN (:participantIds)
          AND m."tenantId" = :tenantId
          AND m."createdAt" > COALESCE(p."lastReadAt", TIMESTAMPTZ 'epoch')
          AND m."createdAt" > COALESCE(p."clearedAt", TIMESTAMPTZ 'epoch')
          AND m."senderUserId" <> :userId
          ${identity.employeeId ? 'AND (m."senderEmployeeId" IS NULL OR m."senderEmployeeId" <> :employeeId)' : ''}
        GROUP BY m."conversationId"`,
      {
        replacements: {
          participantIds: mine.map((row) => row.id),
          tenantId,
          userId: identity.userId,
          employeeId: identity.employeeId,
        },
        type: QueryTypes.SELECT,
      },
    )) as { conversationId: string; count: number }[];
    return new Map(rows.map((row) => [row.conversationId, Number(row.count)]));
  }

  private preview(body: string | null, attachmentName: string | null) {
    const text = (body ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, PREVIEW_MAX);
    return attachmentName ? `Attachment: ${attachmentName}`.slice(0, PREVIEW_MAX) : '';
  }

  private toConversationRow(
    identity: ChatIdentity,
    conversation: any,
    counterpart: ChatCounterpart,
    unreadCount: number,
  ): ConversationRow {
    return {
      id: conversation.id,
      counterpart,
      lastMessage: conversation.lastMessageAt
        ? {
            preview: conversation.lastMessagePreview ?? '',
            sentAt: conversation.lastMessageAt,
            fromMe: this.isMine(identity, {
              senderUserId: conversation.lastMessageSenderUserId,
              senderEmployeeId: conversation.lastMessageSenderEmployeeId,
            }),
            hasAttachment: String(conversation.lastMessagePreview ?? '').startsWith('Attachment: '),
          }
        : null,
      unreadCount,
      updatedAt: conversation.updatedAt,
    };
  }

  // ==========================================
  // Conversations
  // ==========================================

  /** Recent Conversations: newest first, with the other person, the last message and what is unread. */
  async getConversations(caller: ChatCallerDto, query: GetConversationsQueryDto = {}) {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 30;

    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);
    const Conversation = await this.modelProvider.getChatConversationModel(tenantId);
    const Message = await this.modelProvider.getChatMessageModel(tenantId);

    const mine = (await Participant.findAll({
      where: { tenantId, hiddenAt: null, ...this.mine(identity) },
    })) as any[];
    const empty = { data: [], total: 0, page, limit, totalPages: 1, summary: { unreadConversations: 0, unreadMessages: 0 } };
    if (!mine.length) return empty;

    const mineByConversation = new Map(mine.map((row) => [row.conversationId, row]));
    const conversations = (await Conversation.findAll({
      where: { id: { [Op.in]: [...mineByConversation.keys()] }, lastMessageAt: { [Op.ne]: null } },
      order: [['lastMessageAt', 'DESC']],
    })) as any[];
    if (!conversations.length) return empty;

    const [others, unread] = await Promise.all([
      Participant.findAll({
        where: { tenantId, conversationId: { [Op.in]: conversations.map((c) => c.id) }, id: { [Op.notIn]: mine.map((row) => row.id) } },
      }),
      this.unreadByConversation(tenantId, identity, mine),
    ]);
    const counterparts = await this.counterparts(tenantId, others as any[]);
    const counterpartOf = new Map((others as any[]).map((other) => [other.conversationId, counterparts.get(other.id)!]));

    let rows = conversations
      .filter((conversation) => counterpartOf.has(conversation.id))
      .map((conversation) => this.toConversationRow(identity, conversation, counterpartOf.get(conversation.id)!, unread.get(conversation.id) ?? 0));

    // The totals ignore the search and the unread filter: they are what the nav badge shows.
    const summary = {
      unreadConversations: rows.filter((row) => row.unreadCount > 0).length,
      unreadMessages: rows.reduce((total, row) => total + row.unreadCount, 0),
    };

    const term = query.search?.trim().toLowerCase();
    if (term) {
      // Matches the person's name, or any message text in the conversation (from after it was last cleared).
      const hits = (await Message.findAll({
        where: {
          tenantId,
          conversationId: { [Op.in]: rows.map((row) => row.id) },
          body: { [Op.iLike]: `%${escapeLike(term)}%` },
        },
        attributes: ['conversationId', 'createdAt'],
        limit: SEARCH_HIT_CAP,
        raw: true,
      })) as unknown as { conversationId: string; createdAt: Date }[];
      const matched = new Set(
        hits
          .filter((hit) => {
            const cleared = mineByConversation.get(hit.conversationId)?.clearedAt;
            return !cleared || new Date(hit.createdAt) > new Date(cleared);
          })
          .map((hit) => hit.conversationId),
      );
      rows = rows.filter((row) => row.counterpart.name.toLowerCase().includes(term) || matched.has(row.id));
    }
    if (query.unread) rows = rows.filter((row) => row.unreadCount > 0);

    return {
      data: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
      totalPages: Math.ceil(rows.length / limit) || 1,
      summary,
    };
  }

  async getConversation(caller: ChatCallerDto, conversationId: string): Promise<ConversationRow> {
    const identity = await this.actor(caller);
    const mine = await this.myParticipant(caller.tenantId, identity, conversationId);
    const other = await this.otherParticipant(caller.tenantId, conversationId, mine);
    const Conversation = await this.modelProvider.getChatConversationModel(caller.tenantId);
    const conversation = await Conversation.findOne({ where: { id: conversationId, tenantId: caller.tenantId } });
    if (!conversation) this.notFound();

    const [counterparts, unread] = await Promise.all([
      this.counterparts(caller.tenantId, [other]),
      this.unreadByConversation(caller.tenantId, identity, [mine]),
    ]);
    return this.toConversationRow(identity, conversation, counterparts.get(other.id)!, unread.get(conversationId) ?? 0);
  }

  /** The conversation with this employee — the one that exists, or a new one. */
  async startConversation(caller: ChatCallerDto, dto: StartConversationDto): Promise<ConversationRow> {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    if (dto.employeeId === identity.employeeId) this.fail(HttpStatus.BAD_REQUEST, "You can't start a conversation with yourself.");

    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const employee: any = await Employee.findOne({
      where: { id: dto.employeeId, tenantId },
      attributes: ['id', 'userId', 'firstName', 'lastName', 'status'],
    });
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'Employee not found in this organization.');
    if (!EMPLOYED.includes(employee.status)) {
      this.fail(HttpStatus.BAD_REQUEST, 'You can only message people who currently work here.');
    }

    const pairKey = [this.personKey(identity), this.personKey({ employeeId: employee.id, userId: employee.userId })].sort().join('|');
    const Conversation = await this.modelProvider.getChatConversationModel(tenantId);
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);

    let conversation: any = await Conversation.findOne({ where: { tenantId, pairKey } });
    if (!conversation) {
      try {
        conversation = await Conversation.sequelize!.transaction(async (transaction) => {
          const created: any = await Conversation.create({ tenantId, pairKey } as any, { transaction });
          await Participant.bulkCreate(
            [
              { tenantId, conversationId: created.id, employeeId: identity.employeeId, userId: identity.userId, displayName: identity.name, title: identity.title },
              {
                tenantId,
                conversationId: created.id,
                employeeId: employee.id,
                userId: employee.userId ?? null,
                displayName: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
                title: null,
              },
            ] as any[],
            { transaction },
          );
          return created;
        });
      } catch (error) {
        // Two people started it at the same moment: the other one's conversation is the one.
        if (!(error instanceof UniqueConstraintError)) throw error;
        conversation = await Conversation.findOne({ where: { tenantId, pairKey } });
        if (!conversation) throw error;
      }
    } else {
      // Starting it again brings back one they had deleted from their list.
      await Participant.update({ hiddenAt: null } as any, { where: { tenantId, conversationId: conversation.id, ...this.mine(identity) } });
    }
    return this.getConversation(caller, conversation.id);
  }

  /** Deletes the conversation from this person's list and clears what they could see of it. */
  async removeConversation(caller: ChatCallerDto, conversationId: string) {
    const identity = await this.actor(caller);
    const mine = await this.myParticipant(caller.tenantId, identity, conversationId);
    const now = new Date();
    await mine.update({ hiddenAt: now, clearedAt: now });
    return { deleted: true, id: conversationId };
  }

  // ==========================================
  // Messages
  // ==========================================

  private toMessageRow(identity: ChatIdentity, message: any, otherReadAt: Date | null): ChatMessageRow {
    const fromMe = this.isMine(identity, message);
    const seen = fromMe && otherReadAt !== null && new Date(otherReadAt) >= new Date(message.createdAt);
    return {
      id: message.id,
      conversationId: message.conversationId,
      fromMe,
      body: message.body ?? null,
      attachment: message.attachmentFileId
        ? {
            name: message.attachmentName,
            mimeType: message.attachmentMimeType ?? null,
            sizeBytes: Number(message.attachmentSize ?? 0),
            sizeLabel: sizeLabel(Number(message.attachmentSize ?? 0)),
            downloadPath: `/organization/messages/attachments/${message.id}`,
          }
        : null,
      sentAt: message.createdAt,
      status: fromMe ? (seen ? 'SEEN' : 'SENT') : null,
      seenAt: seen ? otherReadAt : null,
    };
  }

  /**
   * One page of a conversation, oldest first. With nothing it is the newest
   * messages; `before` pages back; `after` returns only what is newer, which
   * is how the open conversation is polled.
   */
  async getMessages(caller: ChatCallerDto, conversationId: string, query: GetChatMessagesQueryDto = {}) {
    if (query.before && query.after) this.fail(HttpStatus.BAD_REQUEST, 'Use either `before` or `after`, not both.');
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const mine = await this.myParticipant(tenantId, identity, conversationId);
    const other = await this.otherParticipant(tenantId, conversationId, mine);
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 30;

    const createdAt: Record<symbol, Date> = {};
    if (mine.clearedAt) createdAt[Op.gt] = mine.clearedAt;
    if (query.before) createdAt[Op.lt] = new Date(query.before);
    if (query.after) {
      // Both bounds may apply; the later of the two wins.
      const after = new Date(query.after);
      createdAt[Op.gt] = mine.clearedAt && new Date(mine.clearedAt) > after ? mine.clearedAt : after;
    }

    const Message = await this.modelProvider.getChatMessageModel(tenantId);
    const forward = Boolean(query.after);
    const found = (await Message.findAll({
      where: { tenantId, conversationId, ...(Reflect.ownKeys(createdAt).length ? { createdAt } : {}) },
      order: [['createdAt', forward ? 'ASC' : 'DESC']],
      limit: limit + 1,
    })) as any[];

    const hasMore = found.length > limit;
    const page = found.slice(0, limit);
    if (!forward) page.reverse();

    return {
      data: page.map((message) => this.toMessageRow(identity, message, other.lastReadAt)),
      hasMore,
      counterpartLastReadAt: other.lastReadAt ?? null,
    };
  }

  async sendMessage(
    caller: ChatCallerDto,
    conversationId: string,
    dto: SendChatMessageDto,
    attachment?: ChatAttachmentDto,
  ): Promise<ChatMessageRow> {
    const body = dto.body?.trim() || null;
    if (!body && !attachment) this.fail(HttpStatus.BAD_REQUEST, 'Type a message or attach a file.');
    if (body && body.length > CHAT_BODY_MAX) this.fail(HttpStatus.BAD_REQUEST, `A message can be at most ${CHAT_BODY_MAX} characters.`);

    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const mine = await this.myParticipant(tenantId, identity, conversationId);
    const other = await this.otherParticipant(tenantId, conversationId, mine);

    // Nobody to read it: the other person has left the organization.
    if (other.employeeId) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const employee: any = await Employee.findOne({ where: { id: other.employeeId, tenantId }, attributes: ['status'] });
      if (employee && !EMPLOYED.includes(employee.status)) {
        this.fail(HttpStatus.CONFLICT, 'This person no longer works here, so you can\'t send them a message.');
      }
    }

    const Message = await this.modelProvider.getChatMessageModel(tenantId);
    const Conversation = await this.modelProvider.getChatConversationModel(tenantId);
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);

    const created: any = await Message.sequelize!.transaction(async (transaction) => {
      const message: any = await Message.create(
        {
          tenantId,
          conversationId,
          senderUserId: identity.userId,
          senderEmployeeId: identity.employeeId,
          body,
          attachmentFileId: attachment?.fileId ?? null,
          attachmentName: attachment?.fileName ?? null,
          attachmentMimeType: attachment?.mimeType ?? null,
          attachmentSize: attachment?.sizeBytes ?? null,
        } as any,
        { transaction },
      );
      await Conversation.update(
        {
          lastMessageAt: message.createdAt,
          lastMessagePreview: this.preview(body, attachment?.fileName ?? null),
          lastMessageSenderUserId: identity.userId,
          lastMessageSenderEmployeeId: identity.employeeId,
        } as any,
        { where: { id: conversationId, tenantId }, transaction },
      );
      // A new message brings the conversation back for anyone who had deleted it,
      // and sending one means the sender has read everything before it.
      await Participant.update({ hiddenAt: null } as any, { where: { tenantId, conversationId, hiddenAt: { [Op.ne]: null } }, transaction });
      await mine.update({ lastReadAt: message.createdAt }, { transaction });
      return message;
    });

    return this.toMessageRow(identity, created, other.lastReadAt);
  }

  /** Opens the conversation: everything in it is now read, and the other person sees "seen". */
  async markRead(caller: ChatCallerDto, conversationId: string) {
    const identity = await this.actor(caller);
    const mine = await this.myParticipant(caller.tenantId, identity, conversationId);
    const readAt = new Date();
    await mine.update({ lastReadAt: readAt });
    return { conversationId, readAt, unreadCount: 0 };
  }

  /** The file behind an attachment — only for the two people in the conversation. */
  async getAttachment(caller: ChatCallerDto, messageId: string) {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const Message = await this.modelProvider.getChatMessageModel(tenantId);
    const message: any = await Message.findOne({ where: { id: messageId, tenantId } });
    if (!message?.attachmentFileId) this.fail(HttpStatus.NOT_FOUND, 'Attachment not found.');

    const mine = await this.myParticipant(tenantId, identity, message.conversationId);
    if (mine.clearedAt && new Date(message.createdAt) <= new Date(mine.clearedAt)) {
      this.fail(HttpStatus.NOT_FOUND, 'Attachment not found.');
    }
    return { fileId: message.attachmentFileId, fileName: message.attachmentName, mimeType: message.attachmentMimeType ?? null };
  }

  // ==========================================
  // People, presence, badge
  // ==========================================

  /** People to start a conversation with: current employees other than the caller. */
  async getContacts(caller: ChatCallerDto, query: GetChatContactsQueryDto = {}) {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const Designation = await this.modelProvider.getDesignationModel(tenantId);
    const Presence = await this.modelProvider.getChatPresenceModel(tenantId);
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;

    const where: Record<string | symbol, unknown> = { tenantId, status: { [Op.in]: EMPLOYED } };
    if (identity.employeeId) where.id = { [Op.ne]: identity.employeeId };
    const term = query.search?.trim();
    if (term) {
      const like = `%${escapeLike(term)}%`;
      where[Op.or] = [
        { firstName: { [Op.iLike]: like } },
        { lastName: { [Op.iLike]: like } },
        { email: { [Op.iLike]: like } },
        { employeeCode: { [Op.iLike]: like } },
      ];
    }

    const employees = (await Employee.findAll({
      where,
      attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'avatarUrl'],
      include: [
        { model: Designation, as: 'designation', attributes: ['title'], required: false },
        { model: Department, as: 'department', attributes: ['name'], required: false },
      ],
      order: [['firstName', 'ASC'], ['lastName', 'ASC']],
      limit,
    })) as any[];

    const presences = employees.length
      ? ((await Presence.findAll({
          where: { tenantId, employeeId: { [Op.in]: employees.map((employee) => employee.id) } },
          attributes: ['employeeId', 'lastSeenAt'],
        })) as any[])
      : [];
    const lastSeen = new Map(presences.map((p) => [p.employeeId, new Date(p.lastSeenAt).getTime()]));
    const now = Date.now();

    return {
      data: employees.map((employee) => ({
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        name: [employee.firstName, employee.lastName].filter(Boolean).join(' '),
        avatarUrl: employee.avatarUrl ?? null,
        designation: employee.designation?.title ?? null,
        department: employee.department?.name ?? null,
        online: lastSeen.has(employee.id) && now - lastSeen.get(employee.id)! <= ONLINE_WINDOW_MS,
      })),
    };
  }

  /** Says "I'm here" — the screen sends this while it is open, so the person shows as online. */
  async heartbeat(caller: ChatCallerDto) {
    await this.actor(caller);
    return { ok: true, at: new Date() };
  }

  // ==========================================
  // Real time (the gateway's socket layer)
  // ==========================================

  /**
   * Who this login is and who has a conversation with them — what the socket
   * needs to join the right rooms and to tell the right people they came online.
   */
  async identifyForRealtime(caller: ChatCallerDto) {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);
    const mine = (await Participant.findAll({ where: { tenantId, ...this.mine(identity) }, attributes: ['conversationId'] })) as any[];
    const peers = mine.length
      ? ((await Participant.findAll({
          where: { tenantId, conversationId: { [Op.in]: mine.map((row) => row.conversationId) }, ...this.notMe(identity) },
          attributes: ['employeeId', 'userId'],
        })) as any[])
      : [];
    return {
      userId: identity.userId,
      employeeId: identity.employeeId,
      peers: peers.map((peer) => ({ employeeId: peer.employeeId ?? null, userId: peer.userId ?? null })),
    };
  }

  /** The other person in one of the caller's conversations — who a typing signal, a new message or a read receipt goes to. */
  async getPeer(caller: ChatCallerDto, conversationId: string) {
    const identity = await this.identify(caller);
    const mine = await this.myParticipant(caller.tenantId, identity, conversationId);
    const other = await this.otherParticipant(caller.tenantId, conversationId, mine);
    return { employeeId: other.employeeId ?? null, userId: other.userId ?? null };
  }

  /** The person's last socket closed: show them offline now rather than after the online window runs out. */
  async goOffline(caller: ChatCallerDto) {
    const identity = await this.identify(caller);
    try {
      const Presence = await this.modelProvider.getChatPresenceModel(caller.tenantId);
      await Presence.update(
        { lastSeenAt: new Date(Date.now() - ONLINE_WINDOW_MS - 1000) } as any,
        { where: { tenantId: caller.tenantId, userId: identity.userId } },
      );
    } catch (error: any) {
      this.logger.warn(`Presence not cleared: ${error?.message ?? error}`);
    }
    return { ok: true };
  }

  /** Rows that belong to someone other than this person. */
  private notMe(identity: ChatIdentity) {
    const clauses: Record<string, unknown>[] = [{ [Op.or]: [{ userId: null }, { userId: { [Op.ne]: identity.userId } }] }];
    if (identity.employeeId) clauses.push({ [Op.or]: [{ employeeId: null }, { employeeId: { [Op.ne]: identity.employeeId } }] });
    return { [Op.and]: clauses };
  }

  /** Just the numbers, for the sidebar badge. */
  async getUnread(caller: ChatCallerDto) {
    const { tenantId } = caller;
    const identity = await this.actor(caller);
    const Participant = await this.modelProvider.getChatParticipantModel(tenantId);
    const mine = (await Participant.findAll({ where: { tenantId, hiddenAt: null, ...this.mine(identity) } })) as any[];
    const unread = await this.unreadByConversation(tenantId, identity, mine);
    return {
      unreadConversations: unread.size,
      unreadMessages: [...unread.values()].reduce((total, count) => total + count, 0),
    };
  }
}
