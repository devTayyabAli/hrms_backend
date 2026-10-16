import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import type { Namespace } from 'socket.io';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';

export interface ChatPerson {
  employeeId?: string | null;
  userId?: string | null;
}

export interface ChatCaller {
  tenantId: string;
  userId: string;
  email?: string;
}

/** Room names. Tenant-prefixed so two organizations can never share one. */
export const userRoom = (tenantId: string, userId: string) => `t:${tenantId}:u:${userId}`;
export const employeeRoom = (tenantId: string, employeeId: string) => `t:${tenantId}:e:${employeeId}`;

/**
 * Pushes chat events to connected people. Used by the socket gateway and by the
 * HTTP controller, so a message sent over either reaches the other person live.
 *
 * Publishing never fails the caller: the message is already saved, and the
 * recipient's screen catches up from the REST endpoints if a push is missed.
 */
@Injectable()
export class ChatRealtimeService {
  private readonly logger = new Logger(ChatRealtimeService.name);
  private namespace: Namespace | null = null;

  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  bind(namespace: Namespace) {
    this.namespace = namespace;
  }

  socketById(socketId: string) {
    return this.namespace?.sockets.get(socketId);
  }

  /** Every room a person can be reached in: their login, and their employee record when they have one. */
  roomsFor(tenantId: string, person: ChatPerson): string[] {
    const rooms: string[] = [];
    if (person.userId) rooms.push(userRoom(tenantId, person.userId));
    if (person.employeeId) rooms.push(employeeRoom(tenantId, person.employeeId));
    return rooms;
  }

  /** Emits to the given rooms; a person in two rooms still gets it once. */
  emitTo(rooms: string[], event: string, payload: unknown, exceptSocketId?: string) {
    if (!this.namespace || !rooms.length) return;
    let target = this.namespace.to(rooms);
    if (exceptSocketId) target = target.except(exceptSocketId);
    target.emit(event, payload);
  }

  async peerOf(caller: ChatCaller, conversationId: string): Promise<ChatPerson> {
    return firstValueFrom(this.tenantClient.send<ChatPerson>(MESSAGE_PATTERNS.CHAT.GET_PEER, { ...caller, conversationId }));
  }

  /**
   * A message was saved. The other person gets it as theirs (not from them
   * to themselves); the sender's other open tabs get it as sent. The socket
   * that sent it is skipped — it already has the acknowledgement.
   */
  async publishMessage(caller: ChatCaller, conversationId: string, message: any, exceptSocketId?: string) {
    try {
      const peer = await this.peerOf(caller, conversationId);
      this.emitTo(
        this.roomsFor(caller.tenantId, peer),
        'chat:message',
        { conversationId, message: { ...message, fromMe: false, status: null, seenAt: null } },
      );
      this.emitTo(
        [userRoom(caller.tenantId, caller.userId)],
        'chat:message',
        { conversationId, message },
        exceptSocketId,
      );
    } catch (error: any) {
      this.logger.warn(`Message push skipped: ${error?.message ?? error}`);
    }
  }

  /** Someone opened the conversation: the other person's messages turn "seen". */
  async publishRead(caller: ChatCaller, conversationId: string, readAt: Date | string, exceptSocketId?: string) {
    try {
      const peer = await this.peerOf(caller, conversationId);
      this.emitTo(this.roomsFor(caller.tenantId, peer), 'chat:read', { conversationId, readAt, byMe: false });
      // The reader's other tabs clear their unread badge.
      this.emitTo([userRoom(caller.tenantId, caller.userId)], 'chat:read', { conversationId, readAt, byMe: true }, exceptSocketId);
    } catch (error: any) {
      this.logger.warn(`Read receipt push skipped: ${error?.message ?? error}`);
    }
  }

  /** Someone came online or went offline: tell the people who have a conversation with them. */
  publishPresence(tenantId: string, who: ChatPerson, peers: ChatPerson[], online: boolean) {
    const rooms = [...new Set(peers.flatMap((peer) => this.roomsFor(tenantId, peer)))];
    this.emitTo(rooms, 'chat:presence', {
      employeeId: who.employeeId ?? null,
      userId: who.userId ?? null,
      online,
      lastSeenAt: online ? null : new Date().toISOString(),
    });
  }
}
