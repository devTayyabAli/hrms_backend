import { Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClientProxy } from '@nestjs/microservices';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { firstValueFrom } from 'rxjs';
import type { Namespace, Socket } from 'socket.io';
import {
  CHAT_BODY_MAX,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
  SendChatMessageDto,
} from '@app/common';
import { requireJwtSecret } from '@app/tenant-context';
import { resolveOwnFile } from '../utils/chat-attachment';
import { ChatPerson, ChatRealtimeService, employeeRoom, userRoom } from './chat-realtime.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** After the access token expires the client has this long to send a fresh one before the socket is closed. */
const REAUTH_GRACE_MS = 20_000;
/** How often connected people are marked present and their sessions are re-checked. */
const SWEEP_EVERY_MS = 60_000;
/** Events a socket may send per window — typing signals included — before it is told to slow down. */
const RATE_LIMIT_EVENTS = 40;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** A typing signal re-uses the conversation's other person for this long instead of asking tenant-service on every keystroke. */
const PEER_CACHE_MS = 5 * 60_000;

interface SocketUser {
  id: string;
  email?: string;
  tenantId: string;
  sid?: string;
  exp: number;
  permissions: string[];
  isFullAccess: boolean;
  employeeId: string | null;
  peers: ChatPerson[];
}

interface SocketState {
  user: SocketUser;
  expiryTimer?: NodeJS.Timeout;
  graceTimer?: NodeJS.Timeout;
  windowStart: number;
  windowCount: number;
  peerCache: Map<string, { peer: ChatPerson; at: number }>;
}

type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: { status: number; message: string } };

class SocketAuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/**
 * Real-time Messages. Everything the REST endpoints do still works; this only
 * adds the push: a new message, "seen", typing and online/offline arrive the
 * moment they happen instead of on the next poll.
 *
 * Connects at `/chat` (path `/api/v1/socket.io`) with the access token in the
 * handshake `auth`. The token is checked the way an HTTP request is: signature
 * and expiry, that it is an access token, that the session has not been
 * signed out, that the organization is active and has the Messages module,
 * and that the person may use Messages. The organization comes from the token,
 * never from the client.
 *
 * Access tokens are short-lived, so the client sends a fresh one with
 * `chat:reauth` after each refresh; a socket whose token ran out without one
 * is closed after a short grace period.
 */
@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly jwt: JwtService;
  private readonly secret: string;
  private readonly states = new Map<string, SocketState>();
  /** How many sockets each person has open — they are "online" while it is above zero. */
  private readonly connections = new Map<string, number>();
  private sweep?: NodeJS.Timeout;

  constructor(
    config: ConfigService,
    private readonly realtime: ChatRealtimeService,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {
    this.secret = requireJwtSecret(config);
    this.jwt = new JwtService({ secret: this.secret });
  }

  // ==========================================
  // Connecting
  // ==========================================

  afterInit(namespace: Namespace) {
    this.realtime.bind(namespace);
    namespace.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        const user = await this.authenticate(typeof token === 'string' ? token : '');
        (socket.data as { user?: SocketUser }).user = user;
        next();
      } catch (error: any) {
        const status = error instanceof SocketAuthError ? error.status : 500;
        if (status >= 500) this.logger.error(`Socket handshake failed: ${error?.message ?? error}`);
        const refusal: any = new Error(error instanceof SocketAuthError ? error.message : 'Could not connect to chat.');
        refusal.data = { status };
        next(refusal);
      }
    });
    this.sweep = setInterval(() => void this.sweepConnections(), SWEEP_EVERY_MS);
    this.sweep.unref?.();
  }

  onModuleDestroy() {
    if (this.sweep) clearInterval(this.sweep);
    for (const state of this.states.values()) this.clearTimers(state);
  }

  async handleConnection(socket: Socket) {
    const user = (socket.data as { user?: SocketUser }).user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    const state: SocketState = { user, windowStart: Date.now(), windowCount: 0, peerCache: new Map() };
    this.states.set(socket.id, state);

    await socket.join(userRoom(user.tenantId, user.id));
    if (user.employeeId) await socket.join(employeeRoom(user.tenantId, user.employeeId));
    this.armExpiry(socket, state);

    const key = this.personKey(user);
    const count = (this.connections.get(key) ?? 0) + 1;
    this.connections.set(key, count);
    if (count === 1) this.realtime.publishPresence(user.tenantId, this.who(user), user.peers, true);

    socket.emit('chat:ready', { userId: user.id, employeeId: user.employeeId, expiresAt: new Date(user.exp * 1000).toISOString() });
  }

  async handleDisconnect(socket: Socket) {
    const state = this.states.get(socket.id);
    if (!state) return;
    this.clearTimers(state);
    this.states.delete(socket.id);

    const { user } = state;
    const key = this.personKey(user);
    const left = (this.connections.get(key) ?? 1) - 1;
    if (left > 0) {
      this.connections.set(key, left);
      return;
    }
    this.connections.delete(key);
    try {
      await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.CHAT.GO_OFFLINE, { tenantId: user.tenantId, userId: user.id, email: user.email }),
      );
    } catch (error: any) {
      this.logger.warn(`Could not mark ${user.id} offline: ${error?.message ?? error}`);
    }
    this.realtime.publishPresence(user.tenantId, this.who(user), user.peers, false);
  }

  // ==========================================
  // Events from the client
  // ==========================================

  @SubscribeMessage('chat:send')
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: any): Promise<Ack> {
    return this.guarded(socket, ['messages.create', 'messages.manage'], async (user) => {
      const conversationId = body?.conversationId;
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
        throw new SocketAuthError('conversationId is required.', 400);
      }
      const dto = plainToInstance(SendChatMessageDto, { body: body?.body, fileId: body?.fileId });
      const problems = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
      if (problems.length) {
        throw new SocketAuthError(Object.values(problems[0].constraints ?? {})[0] ?? 'Invalid message.', 400);
      }
      if (dto.body && dto.body.length > CHAT_BODY_MAX) {
        throw new SocketAuthError(`A message can be at most ${CHAT_BODY_MAX} characters.`, 400);
      }

      const attachment = dto.fileId ? await resolveOwnFile(this.authClient, user.tenantId, user.id, dto.fileId) : undefined;
      const message: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.CHAT.SEND_MESSAGE, { ...this.caller(user), conversationId, dto, attachment }),
      );
      void this.realtime.publishMessage(this.caller(user), conversationId, message, socket.id);
      return { message, clientId: typeof body?.clientId === 'string' ? body.clientId.slice(0, 64) : undefined };
    });
  }

  @SubscribeMessage('chat:read')
  async onRead(@ConnectedSocket() socket: Socket, @MessageBody() body: any): Promise<Ack> {
    return this.guarded(socket, ['messages.view', 'messages.manage'], async (user) => {
      const conversationId = body?.conversationId;
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
        throw new SocketAuthError('conversationId is required.', 400);
      }
      const result: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.CHAT.MARK_READ, { ...this.caller(user), conversationId }),
      );
      void this.realtime.publishRead(this.caller(user), conversationId, result.readAt, socket.id);
      return result;
    });
  }

  @SubscribeMessage('chat:typing')
  async onTyping(@ConnectedSocket() socket: Socket, @MessageBody() body: any): Promise<Ack> {
    return this.guarded(socket, ['messages.create', 'messages.manage'], async (user, state) => {
      const conversationId = body?.conversationId;
      if (typeof conversationId !== 'string' || !UUID.test(conversationId)) {
        throw new SocketAuthError('conversationId is required.', 400);
      }
      let cached = state.peerCache.get(conversationId);
      if (!cached || Date.now() - cached.at > PEER_CACHE_MS) {
        cached = { peer: await this.realtime.peerOf(this.caller(user), conversationId), at: Date.now() };
        state.peerCache.set(conversationId, cached);
        if (state.peerCache.size > 200) state.peerCache.delete(state.peerCache.keys().next().value as string);
      }
      this.realtime.emitTo(this.realtime.roomsFor(user.tenantId, cached.peer), 'chat:typing', {
        conversationId,
        typing: body?.typing !== false,
        userId: user.id,
        employeeId: user.employeeId,
      });
      return undefined;
    });
  }

  /** The client got a new access token after a refresh. Same person, same organization, or it is refused. */
  @SubscribeMessage('chat:reauth')
  async onReauth(@ConnectedSocket() socket: Socket, @MessageBody() body: any): Promise<Ack> {
    const state = this.states.get(socket.id);
    if (!state) return this.failure(new SocketAuthError('Not connected.', 401));
    try {
      const next = await this.authenticate(typeof body?.token === 'string' ? body.token : '');
      if (next.id !== state.user.id || next.tenantId !== state.user.tenantId) {
        throw new SocketAuthError('That token belongs to someone else.', 403);
      }
      // Keep what was learned at connect time; take the new expiry, session and permissions.
      state.user = { ...state.user, exp: next.exp, sid: next.sid, permissions: next.permissions, isFullAccess: next.isFullAccess };
      this.armExpiry(socket, state);
      return { ok: true, data: { expiresAt: new Date(next.exp * 1000).toISOString() } };
    } catch (error) {
      return this.failure(error);
    }
  }

  // ==========================================
  // Authentication
  // ==========================================

  private async authenticate(token: string): Promise<SocketUser> {
    if (!token) throw new SocketAuthError('Sign in to use chat.');

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.secret });
    } catch {
      throw new SocketAuthError('Your session has expired. Please sign in again.');
    }
    // Same rule as the HTTP strategy: only a real access token, never a 2FA challenge or refresh token.
    if (payload?.type !== 'access') throw new SocketAuthError('Token is not a valid access token.');
    const id: string | undefined = payload.id || payload.sub;
    const tenantId: string | undefined = payload.tenantId;
    if (!id || !tenantId || !UUID.test(tenantId)) throw new SocketAuthError('Chat is only available inside an organization.', 403);

    const permissions: string[] = Array.isArray(payload.permissions) ? payload.permissions : [];
    const isFullAccess = !!payload.isFullAccess || permissions.includes('*');
    const user: SocketUser = {
      id,
      email: payload.email,
      tenantId,
      sid: payload.sid,
      exp: Number(payload.exp),
      permissions,
      isFullAccess,
      employeeId: null,
      peers: [],
    };
    if (!this.may(user, ['messages.view', 'messages.manage'])) {
      throw new SocketAuthError('You do not have access to Messages.', 403);
    }

    await this.assertSessionActive(user.sid);
    await this.assertOrganizationAllows(tenantId);

    // Who they are in this organization, and who has a conversation with them (to tell about presence).
    try {
      const profile: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.CHAT.IDENTIFY, { tenantId, userId: id, email: payload.email }),
      );
      user.employeeId = profile?.employeeId ?? null;
      user.peers = Array.isArray(profile?.peers) ? profile.peers : [];
    } catch (error: any) {
      this.logger.warn(`Could not identify ${id} for chat: ${error?.message ?? error}`);
    }
    return user;
  }

  /** Same permission rule as PermissionsGuard: full access, or the permission, or `<resource>.manage` for it. */
  private may(user: Pick<SocketUser, 'permissions' | 'isFullAccess'>, accepted: string[]): boolean {
    if (user.isFullAccess) return true;
    return accepted.some((permission) => {
      if (user.permissions.includes(permission)) return true;
      const dot = permission.lastIndexOf('.');
      return dot > 0 && user.permissions.includes(`${permission.slice(0, dot)}.manage`);
    });
  }

  /** A signed-out session must not keep a socket. An auth-service outage doesn't sign everyone out (same as HTTP). */
  private async assertSessionActive(sessionId?: string) {
    if (!sessionId) return;
    let state: { active: boolean; reason?: string };
    try {
      state = await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.AUTH.GET_SESSION_STATE, { sessionId }));
    } catch (error: any) {
      this.logger.warn(`Session check skipped (auth-service unavailable): ${error?.message ?? error}`);
      return;
    }
    if (!state?.active) throw new SocketAuthError(state?.reason || 'Your session has ended. Please sign in again.');
  }

  /** Active organization with the Messages module. Outages don't lock everyone out (same as HTTP). */
  private async assertOrganizationAllows(tenantId: string) {
    try {
      const access: any = await firstValueFrom(this.tenantClient.send(MESSAGE_PATTERNS.TENANT.GET_ACCESS_STATE, { tenantId }));
      if (!access?.found) throw new SocketAuthError('This organization no longer exists.', 403);
      if (access.status === 'SUSPENDED' || access.isActive === false) {
        throw new SocketAuthError('Organization account is suspended. Please contact support.', 403);
      }
      if (access.status === 'EXPIRED') throw new SocketAuthError('Organization subscription has expired.', 403);

      const entitlement: any = await firstValueFrom(
        this.tenantClient.send(MESSAGE_PATTERNS.ORGANIZATION.CHECK_MODULE_ACCESS, {
          tenantId,
          moduleKey: HRMSModuleKey.NOTIFICATIONS,
          action: ModuleAction.VIEW,
        }),
      );
      if (!entitlement?.enabled || !entitlement?.allowed) {
        throw new SocketAuthError(entitlement?.reason || 'Messages is not enabled for this organization.', 403);
      }
    } catch (error) {
      if (error instanceof SocketAuthError) throw error;
      this.logger.warn(`Organization check skipped (tenant-service unavailable): ${(error as any)?.message ?? error}`);
    }
  }

  // ==========================================
  // Housekeeping
  // ==========================================

  /** One handler wrapper: rate limit, permission, then the work. Errors become an `{ok:false}` acknowledgement. */
  private async guarded(
    socket: Socket,
    accepted: string[],
    work: (user: SocketUser, state: SocketState) => Promise<unknown>,
  ): Promise<Ack> {
    const state = this.states.get(socket.id);
    if (!state) return this.failure(new SocketAuthError('Not connected.', 401));
    try {
      if (Date.now() >= state.user.exp * 1000) throw new SocketAuthError('Your session has expired. Please sign in again.');
      const now = Date.now();
      if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
        state.windowStart = now;
        state.windowCount = 0;
      }
      if (++state.windowCount > RATE_LIMIT_EVENTS) throw new SocketAuthError('You are sending too fast. Please slow down.', 429);
      if (!this.may(state.user, accepted)) throw new SocketAuthError('You do not have permission to do that.', 403);

      const data = await work(state.user, state);
      return { ok: true, data };
    } catch (error) {
      return this.failure(error);
    }
  }

  /** Business errors from tenant-service carry a status and message; anything else is a generic failure. */
  private failure(error: any): Ack {
    const status = Number(error?.status ?? error?.statusCode ?? error?.error?.status) || 500;
    const message =
      status >= 500 ? 'Something went wrong. Please try again.' : String(error?.response?.message ?? error?.message ?? 'Request failed.');
    if (status >= 500) this.logger.error(`Chat event failed: ${error?.message ?? error}`);
    return { ok: false, error: { status, message: Array.isArray(message) ? message[0] : message } };
  }

  private caller(user: SocketUser) {
    return { tenantId: user.tenantId, userId: user.id, email: user.email };
  }

  private who(user: SocketUser): ChatPerson {
    return { userId: user.id, employeeId: user.employeeId };
  }

  private personKey(user: SocketUser) {
    return `${user.tenantId}:${user.id}`;
  }

  /** (Re)starts the countdown to the token's expiry for this socket. */
  private armExpiry(socket: Socket, state: SocketState) {
    this.clearTimers(state);
    const wait = Math.max(0, state.user.exp * 1000 - Date.now());
    state.expiryTimer = setTimeout(() => {
      socket.emit('chat:auth-expired', { graceMs: REAUTH_GRACE_MS });
      state.graceTimer = setTimeout(() => socket.disconnect(true), REAUTH_GRACE_MS);
      state.graceTimer.unref?.();
    }, wait);
    state.expiryTimer.unref?.();
  }

  private clearTimers(state: SocketState) {
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    if (state.graceTimer) clearTimeout(state.graceTimer);
    state.expiryTimer = undefined;
    state.graceTimer = undefined;
  }

  /** Keeps connected people marked present, and drops sockets whose session was signed out meanwhile. */
  private async sweepConnections() {
    try {
      const byPerson = new Map<string, SocketUser>();
      const sessions = new Map<string, string[]>();
      for (const [socketId, state] of this.states) {
        byPerson.set(this.personKey(state.user), state.user);
        if (state.user.sid) sessions.set(state.user.sid, [...(sessions.get(state.user.sid) ?? []), socketId]);
      }

      for (const user of byPerson.values()) {
        firstValueFrom(
          this.tenantClient.send(MESSAGE_PATTERNS.CHAT.HEARTBEAT, { tenantId: user.tenantId, userId: user.id, email: user.email }),
        ).catch((error: any) => this.logger.warn(`Presence refresh failed: ${error?.message ?? error}`));
      }

      for (const [sessionId, socketIds] of sessions) {
        try {
          await this.assertSessionActive(sessionId);
        } catch {
          for (const socketId of socketIds) {
            const socket = this.realtime.socketById(socketId);
            socket?.emit('chat:auth-expired', { graceMs: 0, reason: 'SESSION_ENDED' });
            socket?.disconnect(true);
          }
        }
      }
    } catch (error: any) {
      this.logger.warn(`Connection sweep failed: ${error?.message ?? error}`);
    }
  }
}
