import { Op, UniqueConstraintError } from 'sequelize';
import { EmployeeStatus } from '@app/common';
import { ChatService } from './chat.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ME_USER = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
const ME_EMP = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const FATIMA_USER = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const FATIMA_EMP = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const CONV = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
const CONV2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';

const caller = { tenantId: TENANT, userId: ME_USER, email: 'me@example.com' };

/** A Sequelize-like row whose `update` writes back onto it. */
const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const employee = (id: string, first: string, last: string, over: Record<string, any> = {}) => ({
  id,
  userId: null,
  firstName: first,
  lastName: last,
  avatarUrl: null,
  status: EmployeeStatus.ACTIVE,
  designation: { title: 'HR Manager' },
  department: { name: 'Human Resources' },
  ...over,
});

describe('ChatService', () => {
  let employees: Record<string, any>;
  let employeeModel: any;
  let participantModel: any;
  let conversationModel: any;
  let messageModel: any;
  let presenceModel: any;
  let sequelize: any;
  let tenantService: any;
  let service: ChatService;

  beforeEach(() => {
    // The caller is an employee; Fatima is the other person.
    employees = {
      [ME_EMP]: employee(ME_EMP, 'Sara', 'Khan', { userId: ME_USER }),
      [FATIMA_EMP]: employee(FATIMA_EMP, 'Fatima', 'Noor', { userId: FATIMA_USER }),
    };
    employeeModel = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.userId) return Object.values(employees).find((e: any) => e.userId === where.userId) ?? null;
        if (where.id) return employees[where.id] ?? null;
        if (where.email) return null;
        return null;
      }),
      findAll: jest.fn().mockResolvedValue([]),
    };
    sequelize = {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(async (work: (t: unknown) => unknown) => work('tx')),
    };
    participantModel = {
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue([1]),
      bulkCreate: jest.fn().mockResolvedValue([]),
    };
    conversationModel = {
      sequelize,
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (values: any) => row({ id: CONV, updatedAt: new Date(), ...values })),
      update: jest.fn().mockResolvedValue([1]),
    };
    messageModel = {
      sequelize,
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(async (values: any) => row({ id: 'm-new', createdAt: new Date('2026-10-16T10:12:00Z'), ...values })),
    };
    presenceModel = {
      findOrCreate: jest.fn().mockResolvedValue([row({ lastSeenAt: new Date() }), true]),
      findAll: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue([1]),
    };
    tenantService = { getTenantById: jest.fn().mockResolvedValue({ adminEmail: 'owner@example.com', adminName: 'Zeeshan Kazmi' }) };

    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getDepartmentModel: jest.fn().mockResolvedValue({}),
      getDesignationModel: jest.fn().mockResolvedValue({}),
      getChatParticipantModel: jest.fn().mockResolvedValue(participantModel),
      getChatConversationModel: jest.fn().mockResolvedValue(conversationModel),
      getChatMessageModel: jest.fn().mockResolvedValue(messageModel),
      getChatPresenceModel: jest.fn().mockResolvedValue(presenceModel),
    };
    service = new ChatService(provider, tenantService);
  });

  const mineRow = (over: Record<string, any> = {}) =>
    row({ id: 'p-me', conversationId: CONV, employeeId: ME_EMP, userId: ME_USER, lastReadAt: null, hiddenAt: null, clearedAt: null, ...over });
  const otherRow = (over: Record<string, any> = {}) =>
    row({ id: 'p-other', conversationId: CONV, employeeId: FATIMA_EMP, userId: FATIMA_USER, displayName: 'Fatima Noor', title: null, lastReadAt: null, ...over });

  /** The caller is a participant of CONV, talking to Fatima. */
  const inConversation = (mine = mineRow(), other = otherRow()) => {
    participantModel.findOne.mockImplementation(async ({ where }: any) => (where.id ? other : mine));
    return { mine, other };
  };

  describe('who is asking', () => {
    it('knows an employee by login id', async () => {
      await service.heartbeat(caller);

      expect(presenceModel.findOrCreate.mock.calls[0][0].defaults).toMatchObject({ userId: ME_USER, employeeId: ME_EMP });
    });

    it('knows the organization admin, who has no employee record, by the organization', async () => {
      employees = {};
      tenantService.getTenantById.mockResolvedValue({ adminEmail: 'owner@example.com', adminName: 'Zeeshan Kazmi' });
      const spy = jest.spyOn(service as any, 'touchPresence');

      await service.heartbeat({ tenantId: TENANT, userId: 'admin-login', email: 'Owner@Example.com' });

      expect(spy.mock.calls[0][1]).toEqual({ userId: 'admin-login', employeeId: null, name: 'Zeeshan Kazmi', title: 'Organization Admin' });
    });

    it('names anyone else without a record from their email', async () => {
      employees = {};
      const spy = jest.spyOn(service as any, 'touchPresence');

      await service.heartbeat({ tenantId: TENANT, userId: 'someone', email: 'ayesha.khan@example.com' });

      expect(spy.mock.calls[0][1]).toMatchObject({ employeeId: null, name: 'Ayesha Khan', title: null });
    });

    it('never fails a call because presence could not be written', async () => {
      presenceModel.findOrCreate.mockRejectedValue(new Error('database busy'));

      await expect(service.heartbeat(caller)).resolves.toMatchObject({ ok: true });
    });

    it('does not write presence on every call, only now and then', async () => {
      const recent = row({ lastSeenAt: new Date() });
      presenceModel.findOrCreate.mockResolvedValue([recent, false]);

      await service.heartbeat(caller);

      expect(recent.update).not.toHaveBeenCalled();

      const stale = row({ lastSeenAt: new Date(Date.now() - 60_000) });
      presenceModel.findOrCreate.mockResolvedValue([stale, false]);
      await service.heartbeat(caller);

      expect(stale.update).toHaveBeenCalled();
    });
  });

  describe('starting a conversation', () => {
    beforeEach(() => {
      // Both people exist; the second findOne finds the conversation afterwards.
      conversationModel.findOne.mockResolvedValueOnce(null);
    });

    it('refuses a conversation with yourself', async () => {
      await expect(service.startConversation(caller, { employeeId: ME_EMP })).rejects.toMatchObject({ status: 400 });
    });

    it('is a 404 for someone who is not in the organization', async () => {
      await expect(service.startConversation(caller, { employeeId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({
        status: 404,
      });
    });

    it('refuses someone who no longer works there', async () => {
      employees[FATIMA_EMP].status = EmployeeStatus.RESIGNED;

      await expect(service.startConversation(caller, { employeeId: FATIMA_EMP })).rejects.toMatchObject({ status: 400 });
    });

    it('creates one conversation per pair, with both people on it', async () => {
      conversationModel.findOne
        .mockReset()
        .mockResolvedValueOnce(null) // no existing conversation
        .mockResolvedValueOnce(row({ id: CONV, lastMessageAt: null, updatedAt: new Date() })); // read back by getConversation
      inConversation();

      await service.startConversation(caller, { employeeId: FATIMA_EMP });

      const pairKey = conversationModel.create.mock.calls[0][0].pairKey;
      expect(pairKey).toBe([`e:${ME_EMP}`, `e:${FATIMA_EMP}`].sort().join('|'));
      const people = participantModel.bulkCreate.mock.calls[0][0];
      expect(people.map((p: any) => p.employeeId).sort()).toEqual([ME_EMP, FATIMA_EMP].sort());
      expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    });

    it('returns the existing conversation, and brings it back if it had been deleted', async () => {
      conversationModel.findOne.mockReset().mockResolvedValue(row({ id: CONV, lastMessageAt: null, updatedAt: new Date() }));
      inConversation();

      await service.startConversation(caller, { employeeId: FATIMA_EMP });

      expect(conversationModel.create).not.toHaveBeenCalled();
      expect(participantModel.update).toHaveBeenCalledWith({ hiddenAt: null }, expect.objectContaining({ where: expect.objectContaining({ conversationId: CONV }) }));
    });

    it('uses the other person\'s conversation when two people start it at once', async () => {
      conversationModel.findOne
        .mockReset()
        .mockResolvedValueOnce(null) // not there yet
        .mockResolvedValueOnce(row({ id: CONV, lastMessageAt: null, updatedAt: new Date() })) // there after the clash
        .mockResolvedValueOnce(row({ id: CONV, lastMessageAt: null, updatedAt: new Date() })); // getConversation
      sequelize.transaction.mockRejectedValueOnce(new UniqueConstraintError({}));
      inConversation();

      const result = await service.startConversation(caller, { employeeId: FATIMA_EMP });

      expect(result.id).toBe(CONV);
    });
  });

  describe('recent conversations', () => {
    const conversation = (id: string, lastAt: string, preview: string, fromMe = false) =>
      row({
        id,
        lastMessageAt: new Date(lastAt),
        lastMessagePreview: preview,
        lastMessageSenderUserId: fromMe ? ME_USER : FATIMA_USER,
        lastMessageSenderEmployeeId: fromMe ? ME_EMP : FATIMA_EMP,
        updatedAt: new Date(lastAt),
      });

    beforeEach(() => {
      participantModel.findAll.mockImplementation(async ({ where }: any) =>
        where.id
          ? [otherRow({ id: 'o1', conversationId: CONV }), otherRow({ id: 'o2', conversationId: CONV2, employeeId: null, userId: 'admin-login', displayName: 'Zeeshan Kazmi', title: 'Organization Admin' })]
          : [mineRow({ id: 'p1', conversationId: CONV }), mineRow({ id: 'p2', conversationId: CONV2 })],
      );
      conversationModel.findAll.mockResolvedValue([
        conversation(CONV, '2026-10-16T10:12:00Z', 'Hi Asma, the design files are ready'),
        conversation(CONV2, '2026-10-15T09:00:00Z', 'Great! I\'ll take a look', true),
      ]);
      sequelize.query.mockResolvedValue([{ conversationId: CONV, count: 3 }]);
      employeeModel.findAll.mockResolvedValue([employees[FATIMA_EMP]]);
    });

    it('lists them with the other person, the last message and what is unread', async () => {
      const result = await service.getConversations(caller, {});

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({
        id: CONV,
        unreadCount: 3,
        counterpart: { name: 'Fatima Noor', designation: 'HR Manager', department: 'Human Resources' },
        lastMessage: { preview: 'Hi Asma, the design files are ready', fromMe: false, hasAttachment: false },
      });
      // Someone with no employee record is described by what was saved about them.
      expect(result.data[1].counterpart).toMatchObject({ employeeId: null, name: 'Zeeshan Kazmi', designation: 'Organization Admin' });
      expect(result.data[1].lastMessage?.fromMe).toBe(true);
      expect(result.summary).toEqual({ unreadConversations: 1, unreadMessages: 3 });
    });

    it('only lists conversations that have a message, newest first', async () => {
      await service.getConversations(caller, {});

      const call = conversationModel.findAll.mock.calls[0][0];
      expect(call.where.lastMessageAt).toEqual({ [Op.ne]: null });
      expect(call.order).toEqual([['lastMessageAt', 'DESC']]);
    });

    it('shows someone as online only while their heartbeat is recent', async () => {
      presenceModel.findAll.mockResolvedValue([{ userId: FATIMA_USER, employeeId: FATIMA_EMP, lastSeenAt: new Date() }]);
      expect((await service.getConversations(caller, {})).data[0].counterpart.online).toBe(true);

      presenceModel.findAll.mockResolvedValue([{ userId: FATIMA_USER, employeeId: FATIMA_EMP, lastSeenAt: new Date(Date.now() - 10 * 60_000) }]);
      expect((await service.getConversations(caller, {})).data[0].counterpart.online).toBe(false);
    });

    it('finds a conversation by the person\'s name', async () => {
      const result = await service.getConversations(caller, { search: 'fatima' });

      expect(result.data.map((r) => r.id)).toEqual([CONV]);
    });

    it('finds a conversation by text inside it', async () => {
      messageModel.findAll.mockResolvedValue([{ conversationId: CONV2, createdAt: new Date() }]);

      const result = await service.getConversations(caller, { search: 'take a look' });

      expect(result.data.map((r) => r.id)).toEqual([CONV2]);
      expect(messageModel.findAll.mock.calls[0][0].where.body).toEqual({ [Op.iLike]: '%take a look%' });
    });

    it('does not match text from before the person cleared the conversation', async () => {
      participantModel.findAll.mockImplementation(async ({ where }: any) =>
        where.id
          ? [otherRow({ id: 'o1', conversationId: CONV })]
          : [mineRow({ id: 'p1', conversationId: CONV, clearedAt: new Date('2026-10-16T00:00:00Z') })],
      );
      conversationModel.findAll.mockResolvedValue([conversation(CONV, '2026-10-16T10:12:00Z', 'new')]);
      messageModel.findAll.mockResolvedValue([{ conversationId: CONV, createdAt: new Date('2026-10-10T00:00:00Z') }]);

      const result = await service.getConversations(caller, { search: 'old words' });

      expect(result.data).toEqual([]);
    });

    it('keeps only unread ones on request, but the badge totals stay whole', async () => {
      const result = await service.getConversations(caller, { unread: true });

      expect(result.data.map((r) => r.id)).toEqual([CONV]);
      expect(result.summary.unreadConversations).toBe(1);
    });

    it('pages the list', async () => {
      const result = await service.getConversations(caller, { page: 2, limit: 1 });

      expect(result.data.map((r) => r.id)).toEqual([CONV2]);
      expect(result).toMatchObject({ total: 2, totalPages: 2, page: 2 });
    });

    it('is empty for someone with no conversations', async () => {
      participantModel.findAll.mockResolvedValue([]);

      expect(await service.getConversations(caller, {})).toMatchObject({ data: [], total: 0 });
      expect(conversationModel.findAll).not.toHaveBeenCalled();
    });

    it('counts unread from others only, after the read position and after a clear', async () => {
      await service.getConversations(caller, {});

      const [sql, options] = sequelize.query.mock.calls[0];
      expect(sql).toContain(`COALESCE(p."lastReadAt"`);
      expect(sql).toContain(`COALESCE(p."clearedAt"`);
      expect(sql).toContain(`m."senderUserId" <> :userId`);
      expect(options.replacements).toMatchObject({ userId: ME_USER, employeeId: ME_EMP, participantIds: ['p1', 'p2'] });
    });
  });

  describe('messages', () => {
    const message = (id: string, at: string, fromMe: boolean, extra: Record<string, any> = {}) =>
      row({
        id,
        conversationId: CONV,
        senderUserId: fromMe ? ME_USER : FATIMA_USER,
        senderEmployeeId: fromMe ? ME_EMP : FATIMA_EMP,
        body: `text ${id}`,
        createdAt: new Date(at),
        attachmentFileId: null,
        ...extra,
      });

    it('refuses before and after together', async () => {
      await expect(
        service.getMessages(caller, CONV, { before: '2026-10-16T00:00:00Z', after: '2026-10-15T00:00:00Z' }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('is a 404 for a conversation the caller is not in', async () => {
      await expect(service.getMessages(caller, CONV, {})).rejects.toMatchObject({ status: 404 });
    });

    it('returns the newest page oldest-first, and says when there is more before it', async () => {
      inConversation();
      // Newest first from the database; two requested, three found.
      messageModel.findAll.mockResolvedValue([
        message('m3', '2026-10-16T10:03:00Z', true),
        message('m2', '2026-10-16T10:02:00Z', false),
        message('m1', '2026-10-16T10:01:00Z', true),
      ]);

      const result = await service.getMessages(caller, CONV, { limit: 2 });

      expect(result.data.map((m) => m.id)).toEqual(['m2', 'm3']);
      expect(result.hasMore).toBe(true);
      expect(messageModel.findAll.mock.calls[0][0]).toMatchObject({ order: [['createdAt', 'DESC']], limit: 3 });
    });

    it('marks my message seen only once the other person has read past it', async () => {
      inConversation(mineRow(), otherRow({ lastReadAt: new Date('2026-10-16T10:05:00Z') }));
      messageModel.findAll.mockResolvedValue([
        message('m2', '2026-10-16T10:09:00Z', true),
        message('m1', '2026-10-16T10:01:00Z', true),
      ]);

      const { data } = await service.getMessages(caller, CONV, {});

      expect(data[0]).toMatchObject({ id: 'm1', fromMe: true, status: 'SEEN' });
      expect(data[1]).toMatchObject({ id: 'm2', fromMe: true, status: 'SENT', seenAt: null });
    });

    it('gives their messages no status', async () => {
      inConversation();
      messageModel.findAll.mockResolvedValue([message('m1', '2026-10-16T10:01:00Z', false)]);

      expect((await service.getMessages(caller, CONV, {})).data[0]).toMatchObject({ fromMe: false, status: null });
    });

    it('polls forward with `after`, oldest first', async () => {
      inConversation();
      messageModel.findAll.mockResolvedValue([message('m4', '2026-10-16T10:04:00Z', false)]);

      const result = await service.getMessages(caller, CONV, { after: '2026-10-16T10:03:00Z' });

      const call = messageModel.findAll.mock.calls[0][0];
      expect(call.order).toEqual([['createdAt', 'ASC']]);
      expect(call.where.createdAt[Op.gt]).toEqual(new Date('2026-10-16T10:03:00Z'));
      expect(result.data.map((m) => m.id)).toEqual(['m4']);
    });

    it('pages back with `before`', async () => {
      inConversation();

      await service.getMessages(caller, CONV, { before: '2026-10-16T10:00:00Z' });

      expect(messageModel.findAll.mock.calls[0][0].where.createdAt[Op.lt]).toEqual(new Date('2026-10-16T10:00:00Z'));
    });

    it('never shows what was there before the person cleared the conversation', async () => {
      const cleared = new Date('2026-10-16T08:00:00Z');
      inConversation(mineRow({ clearedAt: cleared }));

      await service.getMessages(caller, CONV, {});

      expect(messageModel.findAll.mock.calls[0][0].where.createdAt[Op.gt]).toEqual(cleared);
    });

    it('describes an attachment on a message', async () => {
      inConversation();
      messageModel.findAll.mockResolvedValue([
        message('m1', '2026-10-16T10:01:00Z', false, {
          attachmentFileId: 'file-1',
          attachmentName: 'September-10 test.pdf',
          attachmentMimeType: 'application/pdf',
          attachmentSize: 245_760,
        }),
      ]);

      const [m] = (await service.getMessages(caller, CONV, {})).data;

      expect(m.attachment).toEqual({
        name: 'September-10 test.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 245_760,
        sizeLabel: '240 KB',
        downloadPath: '/organization/messages/attachments/m1',
      });
    });
  });

  describe('sending', () => {
    it('needs text or a file', async () => {
      await expect(service.sendMessage(caller, CONV, { body: '   ' })).rejects.toMatchObject({
        status: 400,
        message: 'Type a message or attach a file.',
      });
    });

    it('is a 404 for a conversation the caller is not in', async () => {
      await expect(service.sendMessage(caller, CONV, { body: 'hi' })).rejects.toMatchObject({ status: 404 });
      expect(messageModel.create).not.toHaveBeenCalled();
    });

    it('stores the message, updates the preview, brings the conversation back and counts as read', async () => {
      const { mine } = inConversation();

      const sent = await service.sendMessage(caller, CONV, { body: '  Hello there  ' });

      expect(messageModel.create.mock.calls[0][0]).toMatchObject({
        conversationId: CONV,
        senderUserId: ME_USER,
        senderEmployeeId: ME_EMP,
        body: 'Hello there',
        attachmentFileId: null,
      });
      expect(conversationModel.update.mock.calls[0][0]).toMatchObject({
        lastMessagePreview: 'Hello there',
        lastMessageSenderUserId: ME_USER,
      });
      expect(participantModel.update).toHaveBeenCalledWith({ hiddenAt: null }, expect.anything());
      expect(mine.update).toHaveBeenCalledWith({ lastReadAt: expect.any(Date) }, { transaction: 'tx' });
      expect(sent).toMatchObject({ fromMe: true, status: 'SENT', body: 'Hello there' });
      expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    });

    it('sends a file with no text, previewed by its name', async () => {
      inConversation();

      const sent = await service.sendMessage(
        caller,
        CONV,
        {},
        { fileId: 'file-1', fileName: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
      );

      expect(messageModel.create.mock.calls[0][0]).toMatchObject({ body: null, attachmentFileId: 'file-1', attachmentName: 'brief.pdf', attachmentSize: 2048 });
      expect(conversationModel.update.mock.calls[0][0].lastMessagePreview).toBe('Attachment: brief.pdf');
      expect(sent.attachment).toMatchObject({ name: 'brief.pdf', sizeLabel: '2 KB' });
    });

    it('refuses a message to someone who has left', async () => {
      inConversation();
      employees[FATIMA_EMP].status = EmployeeStatus.RESIGNED;

      await expect(service.sendMessage(caller, CONV, { body: 'hello?' })).rejects.toMatchObject({ status: 409 });
    });

    it('refuses text longer than the limit', async () => {
      inConversation();

      await expect(service.sendMessage(caller, CONV, { body: 'x'.repeat(4001) })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('reading, deleting, attachments', () => {
    it('opening a conversation marks it read', async () => {
      const { mine } = inConversation();

      const result = await service.markRead(caller, CONV);

      expect(mine.update).toHaveBeenCalledWith({ lastReadAt: expect.any(Date) });
      expect(result).toMatchObject({ conversationId: CONV, unreadCount: 0 });
    });

    it('deleting hides it from this person and clears what they could see', async () => {
      const { mine } = inConversation();

      await expect(service.removeConversation(caller, CONV)).resolves.toEqual({ deleted: true, id: CONV });

      expect(mine.update).toHaveBeenCalledWith({ hiddenAt: expect.any(Date), clearedAt: expect.any(Date) });
    });

    it('is a 404 to delete or read a conversation that is not yours', async () => {
      await expect(service.removeConversation(caller, CONV)).rejects.toMatchObject({ status: 404 });
      await expect(service.markRead(caller, CONV)).rejects.toMatchObject({ status: 404 });
    });

    it('gives an attachment to a participant', async () => {
      inConversation();
      messageModel.findOne.mockResolvedValue(
        row({ id: 'm1', conversationId: CONV, createdAt: new Date(), attachmentFileId: 'file-1', attachmentName: 'brief.pdf', attachmentMimeType: 'application/pdf' }),
      );

      await expect(service.getAttachment(caller, 'm1')).resolves.toEqual({ fileId: 'file-1', fileName: 'brief.pdf', mimeType: 'application/pdf' });
    });

    it('keeps an attachment from anyone outside the conversation', async () => {
      messageModel.findOne.mockResolvedValue(row({ id: 'm1', conversationId: CONV, createdAt: new Date(), attachmentFileId: 'file-1' }));

      await expect(service.getAttachment(caller, 'm1')).rejects.toMatchObject({ status: 404 });
    });

    it('keeps an attachment from before the person cleared the conversation', async () => {
      inConversation(mineRow({ clearedAt: new Date('2026-10-16T00:00:00Z') }));
      messageModel.findOne.mockResolvedValue(
        row({ id: 'm1', conversationId: CONV, createdAt: new Date('2026-10-10T00:00:00Z'), attachmentFileId: 'file-1' }),
      );

      await expect(service.getAttachment(caller, 'm1')).rejects.toMatchObject({ status: 404 });
    });

    it('is a 404 for a message with no attachment', async () => {
      messageModel.findOne.mockResolvedValue(row({ id: 'm1', conversationId: CONV, attachmentFileId: null }));

      await expect(service.getAttachment(caller, 'm1')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('contacts and badge', () => {
    it('lists current employees other than the caller, searchable, with who is online', async () => {
      employeeModel.findAll.mockResolvedValue([employee(FATIMA_EMP, 'Fatima', 'Noor', { employeeCode: 'EMP006' })]);
      presenceModel.findAll.mockResolvedValue([{ employeeId: FATIMA_EMP, lastSeenAt: new Date() }]);

      const { data } = await service.getContacts(caller, { search: '50%', limit: 10 });

      const where = employeeModel.findAll.mock.calls[0][0].where;
      expect(where.id).toEqual({ [Op.ne]: ME_EMP });
      expect(where.status).toEqual({ [Op.in]: [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE] });
      expect(where[Op.or][0]).toEqual({ firstName: { [Op.iLike]: '%50\\%%' } });
      expect(data[0]).toMatchObject({ employeeId: FATIMA_EMP, name: 'Fatima Noor', designation: 'HR Manager', online: true });
    });

    it('totals unread conversations and messages for the badge', async () => {
      participantModel.findAll.mockResolvedValue([mineRow({ id: 'p1', conversationId: CONV }), mineRow({ id: 'p2', conversationId: CONV2 })]);
      sequelize.query.mockResolvedValue([
        { conversationId: CONV, count: 2 },
        { conversationId: CONV2, count: 5 },
      ]);

      await expect(service.getUnread(caller)).resolves.toEqual({ unreadConversations: 2, unreadMessages: 7 });
    });
  });
  describe('real time', () => {
    it('lists who has a conversation with the caller, so presence reaches them', async () => {
      participantModel.findAll
        .mockResolvedValueOnce([{ conversationId: CONV }, { conversationId: CONV2 }])
        .mockResolvedValueOnce([
          { employeeId: FATIMA_EMP, userId: FATIMA_USER },
          { employeeId: null, userId: 'admin-login' },
        ]);

      const result = await service.identifyForRealtime(caller);

      expect(result).toEqual({
        userId: ME_USER,
        employeeId: ME_EMP,
        peers: [
          { employeeId: FATIMA_EMP, userId: FATIMA_USER },
          { employeeId: null, userId: 'admin-login' },
        ],
      });
      // The second lookup excludes the caller's own rows.
      const where = participantModel.findAll.mock.calls[1][0].where;
      expect(where.conversationId[Op.in]).toEqual([CONV, CONV2]);
      expect(where[Op.and]).toHaveLength(2);
    });

    it('has no peers to look up for someone with no conversations', async () => {
      const result = await service.identifyForRealtime(caller);

      expect(result.peers).toEqual([]);
      expect(participantModel.findAll).toHaveBeenCalledTimes(1);
    });

    it('names the other person of a conversation, and only for a participant', async () => {
      inConversation();
      expect(await service.getPeer(caller, CONV)).toEqual({ employeeId: FATIMA_EMP, userId: FATIMA_USER });

      participantModel.findOne.mockResolvedValue(null);
      await expect(service.getPeer(caller, CONV)).rejects.toMatchObject({ status: 404 });
    });

    it('shows a person offline right away when their last socket closes', async () => {
      await service.goOffline(caller);

      const [patch, options] = presenceModel.update.mock.calls[0];
      expect(Date.now() - new Date(patch.lastSeenAt).getTime()).toBeGreaterThan(2 * 60 * 1000);
      expect(options.where).toEqual({ tenantId: TENANT, userId: ME_USER });
    });

    it('does not fail when presence cannot be cleared', async () => {
      presenceModel.update.mockRejectedValue(new Error('database busy'));

      await expect(service.goOffline(caller)).resolves.toEqual({ ok: true });
    });
  });
});
