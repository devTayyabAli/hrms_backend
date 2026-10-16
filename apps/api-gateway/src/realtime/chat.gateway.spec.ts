import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { of, throwError } from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';
import { ChatGateway } from './chat.gateway';
import { ChatIoAdapter, SOCKET_PATH } from './chat-io.adapter';
import { ChatRealtimeService } from './chat-realtime.service';

const SECRET = 'test-secret-for-chat-gateway';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ANNA = { userId: 'user-anna', employeeId: 'emp-anna' };
const BEN = { userId: 'user-ben', employeeId: 'emp-ben' };

const tokenFor = (jwt: JwtService, who: { userId: string }, extra: Record<string, unknown> = {}) =>
  jwt.sign(
    { id: who.userId, email: `${who.userId}@x.test`, tenantId: TENANT, type: 'access', sid: `sid-${who.userId}`, permissions: ['messages.manage'], ...extra },
    { expiresIn: 600 },
  );

/** Runs the real gateway behind the real adapter; only the TCP clients to other services are faked. */
describe('ChatGateway (real sockets)', () => {
  let app: INestApplication;
  let url: string;
  let jwt: JwtService;
  let sessionActive = true;
  let moduleEnabled = true;
  const sent: { pattern: string; payload: any }[] = [];
  const open: Socket[] = [];

  const tenantClient = {
    send: jest.fn((pattern: string, payload: any) => {
      sent.push({ pattern, payload });
      switch (pattern) {
        case MESSAGE_PATTERNS.TENANT.GET_ACCESS_STATE:
          return of({ found: true, status: 'ACTIVE', isActive: true });
        case MESSAGE_PATTERNS.ORGANIZATION.CHECK_MODULE_ACCESS:
          return of({ enabled: moduleEnabled, allowed: moduleEnabled, reason: 'Messages is not enabled.' });
        case MESSAGE_PATTERNS.CHAT.IDENTIFY: {
          const me = payload.userId === ANNA.userId ? ANNA : BEN;
          const other = me === ANNA ? BEN : ANNA;
          return of({ ...me, peers: [other] });
        }
        case MESSAGE_PATTERNS.CHAT.GET_PEER:
          return of(payload.userId === ANNA.userId ? BEN : ANNA);
        case MESSAGE_PATTERNS.CHAT.SEND_MESSAGE:
          if (payload.dto.body === 'boom') return throwError(() => ({ status: 409, message: 'This person no longer works here.' }));
          return of({ id: 'm1', conversationId: payload.conversationId, fromMe: true, body: payload.dto.body, status: 'SENT', seenAt: null });
        case MESSAGE_PATTERNS.CHAT.MARK_READ:
          return of({ conversationId: payload.conversationId, readAt: '2026-01-01T00:00:00.000Z', unreadCount: 0 });
        default:
          return of({ ok: true });
      }
    }),
  };
  const authClient = {
    send: jest.fn((pattern: string) =>
      pattern === MESSAGE_PATTERNS.AUTH.GET_SESSION_STATE ? of(sessionActive ? { active: true } : { active: false, reason: 'Signed out.' }) : of({}),
    ),
  };

  const connect = (token: string | undefined) => {
    const socket = io(`${url}/chat`, { path: SOCKET_PATH, transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
    open.push(socket);
    return socket;
  };
  const ready = (socket: Socket) =>
    new Promise<any>((resolve, reject) => {
      socket.once('chat:ready', resolve);
      socket.once('connect_error', reject);
    });
  const next = <T = any>(socket: Socket, event: string) => new Promise<T>((resolve) => socket.once(event, resolve));
  const emit = (socket: Socket, event: string, body: unknown) => socket.timeout(3000).emitWithAck(event, body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        ChatRealtimeService,
        { provide: ConfigService, useValue: { get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined) } },
        { provide: SERVICES.TENANT_SERVICE, useValue: tenantClient },
        { provide: SERVICES.AUTH_SERVICE, useValue: authClient },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new ChatIoAdapter(app, ['http://localhost:3000']));
    await app.listen(0);
    url = (await app.getUrl()).replace('[::1]', 'localhost');
    jwt = new JwtService({ secret: SECRET });
  });

  afterEach(() => {
    open.splice(0).forEach((socket) => socket.close());
    sent.length = 0;
    sessionActive = true;
    moduleEnabled = true;
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a connection with no token, a bad token, or a non-access token', async () => {
    await expect(ready(connect(undefined))).rejects.toMatchObject({ message: 'Sign in to use chat.' });
    await expect(ready(connect('garbage'))).rejects.toMatchObject({ message: expect.stringContaining('expired') });
    await expect(ready(connect(tokenFor(jwt, ANNA, { type: 'refresh' })))).rejects.toMatchObject({
      message: 'Token is not a valid access token.',
    });
  });

  it('refuses people without Messages permission, a signed-out session, or a disabled module', async () => {
    await expect(ready(connect(tokenFor(jwt, ANNA, { permissions: ['leave.view'] })))).rejects.toMatchObject({
      message: 'You do not have access to Messages.',
    });
    sessionActive = false;
    await expect(ready(connect(tokenFor(jwt, ANNA)))).rejects.toMatchObject({ message: 'Signed out.' });
    sessionActive = true;
    moduleEnabled = false;
    await expect(ready(connect(tokenFor(jwt, ANNA)))).rejects.toMatchObject({ message: 'Messages is not enabled.' });
  });

  it('refuses a token with no organization (the platform owner)', async () => {
    await expect(ready(connect(tokenFor(jwt, ANNA, { tenantId: undefined })))).rejects.toMatchObject({
      message: 'Chat is only available inside an organization.',
    });
  });

  it('delivers a sent message to the other person, but not back to the sending socket', async () => {
    const anna = connect(tokenFor(jwt, ANNA));
    const ben = connect(tokenFor(jwt, BEN));
    await Promise.all([ready(anna), ready(ben)]);

    const echoed = jest.fn();
    anna.on('chat:message', echoed);
    const incoming = next(ben, 'chat:message');
    const ack = await emit(anna, 'chat:send', { conversationId: CONVERSATION, body: 'hello', clientId: 'c-1' });

    expect(ack).toMatchObject({ ok: true, data: { clientId: 'c-1', message: { id: 'm1', body: 'hello', fromMe: true } } });
    expect(await incoming).toMatchObject({ conversationId: CONVERSATION, message: { body: 'hello', fromMe: false, status: null } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(echoed).not.toHaveBeenCalled();
  });

  it('shows a sent message on the sender\'s other tab', async () => {
    const tab1 = connect(tokenFor(jwt, ANNA));
    const tab2 = connect(tokenFor(jwt, ANNA));
    await Promise.all([ready(tab1), ready(tab2)]);
    const mirrored = next(tab2, 'chat:message');
    await emit(tab1, 'chat:send', { conversationId: CONVERSATION, body: 'from tab 1' });
    expect(await mirrored).toMatchObject({ message: { body: 'from tab 1', fromMe: true } });
  });

  it('answers a failed send with the real reason, and rejects malformed input', async () => {
    const anna = connect(tokenFor(jwt, ANNA));
    await ready(anna);
    expect(await emit(anna, 'chat:send', { conversationId: CONVERSATION, body: 'boom' })).toEqual({
      ok: false,
      error: { status: 409, message: 'This person no longer works here.' },
    });
    expect(await emit(anna, 'chat:send', { conversationId: 'nope', body: 'x' })).toMatchObject({ ok: false, error: { status: 400 } });
    expect(await emit(anna, 'chat:send', { conversationId: CONVERSATION, body: 'x'.repeat(5000) })).toMatchObject({ ok: false, error: { status: 400 } });
  });

  it('tells the other person a conversation was read, and relays typing', async () => {
    const anna = connect(tokenFor(jwt, ANNA));
    const ben = connect(tokenFor(jwt, BEN));
    await Promise.all([ready(anna), ready(ben)]);

    const read = next(ben, 'chat:read');
    expect(await emit(anna, 'chat:read', { conversationId: CONVERSATION })).toMatchObject({ ok: true, data: { unreadCount: 0 } });
    expect(await read).toMatchObject({ conversationId: CONVERSATION, byMe: false, readAt: '2026-01-01T00:00:00.000Z' });

    const typing = next(ben, 'chat:typing');
    await emit(anna, 'chat:typing', { conversationId: CONVERSATION, typing: true });
    expect(await typing).toMatchObject({ conversationId: CONVERSATION, typing: true, userId: ANNA.userId });
  });

  it('announces online on connect and offline when the last socket closes', async () => {
    const ben = connect(tokenFor(jwt, BEN));
    await ready(ben);

    const online = next(ben, 'chat:presence');
    const anna1 = connect(tokenFor(jwt, ANNA));
    await ready(anna1);
    expect(await online).toMatchObject({ userId: ANNA.userId, employeeId: ANNA.employeeId, online: true });

    // A second tab opening or closing is not news.
    const anna2 = connect(tokenFor(jwt, ANNA));
    await ready(anna2);
    const presence = jest.fn();
    ben.on('chat:presence', presence);
    anna2.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(presence).not.toHaveBeenCalled();

    const offline = next(ben, 'chat:presence');
    anna1.close();
    expect(await offline).toMatchObject({ userId: ANNA.userId, online: false });
    expect(sent.some((call) => call.pattern === MESSAGE_PATTERNS.CHAT.GO_OFFLINE && call.payload.userId === ANNA.userId)).toBe(true);
  });

  it('accepts a fresh token for the same person and refuses one for someone else', async () => {
    const anna = connect(tokenFor(jwt, ANNA));
    await ready(anna);
    expect(await emit(anna, 'chat:reauth', { token: tokenFor(jwt, ANNA) })).toMatchObject({ ok: true });
    expect(await emit(anna, 'chat:reauth', { token: tokenFor(jwt, BEN) })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await emit(anna, 'chat:reauth', { token: 'garbage' })).toMatchObject({ ok: false, error: { status: 401 } });
  });

  it('warns and then closes a socket whose token ran out without a refresh', async () => {
    // Signed by hand: `exp` in the payload and `expiresIn` together make jsonwebtoken throw.
    const short = jwt.sign({ id: ANNA.userId, tenantId: TENANT, type: 'access', permissions: ['messages.manage'], exp: Math.floor(Date.now() / 1000) + 1 });
    const socket = connect(short);
    await ready(socket);
    const expired = await next(socket, 'chat:auth-expired');
    expect(expired).toMatchObject({ graceMs: expect.any(Number) });
  }, 10000);
});
