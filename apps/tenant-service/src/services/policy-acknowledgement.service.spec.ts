import { Op } from 'sequelize';
import { PolicyAcknowledgementService, inAudience, normalizeAudience } from './policy-acknowledgement.service';
import { addDays } from './learning-shared';
import { todayIso } from './workspace-shared';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BEN = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const CARA = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const ENG = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const OPS = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const actor = { tenantId: TENANT, userId: 'user-hr', email: 'hr@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const person = (id: string, first: string, departmentId: string | null = ENG) => ({ id, firstName: first, lastName: 'Khan', employeeCode: `E-${first}`, avatarUrl: null, departmentId });

const doc = (over: Record<string, any> = {}) =>
  row({
    id: DOC,
    tenantId: TENANT,
    name: 'Code of Conduct',
    category: 'POLICY',
    status: 'PUBLISHED',
    description: null,
    fileId: 'f1',
    fileName: 'conduct.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    publishedAt: new Date('2026-10-01'),
    requiresAcknowledgement: true,
    audience: null,
    acknowledgeBy: null,
    acknowledgementVersion: 1,
    ...over,
  });

describe('audience helpers', () => {
  it('treats nothing, or an empty audience, as everyone', () => {
    expect(normalizeAudience(null)).toBeNull();
    expect(normalizeAudience({ departmentIds: [], employeeIds: [] })).toBeNull();
    expect(normalizeAudience({ departmentIds: [ENG, ENG], employeeIds: [] })).toEqual({ departmentIds: [ENG], employeeIds: [] });
  });

  it('reaches people by department or by name', () => {
    const audience = { departmentIds: [ENG], employeeIds: [CARA] };
    expect(inAudience(null, { id: BEN })).toBe(true);
    expect(inAudience(audience, { id: ANNA, departmentId: ENG })).toBe(true);
    expect(inAudience(audience, { id: CARA, departmentId: OPS })).toBe(true);
    expect(inAudience(audience, { id: BEN, departmentId: OPS })).toBe(false);
    expect(inAudience(audience, { id: BEN, departmentId: null })).toBe(false);
  });
});

describe('PolicyAcknowledgementService', () => {
  const today = todayIso();
  let docModel: any;
  let ackModel: any;
  let noticeModel: any;
  let employeeModel: any;
  let departmentModel: any;
  let notices: any[];
  let auditModel: { create: jest.Mock };
  let service: PolicyAcknowledgementService;
  let everyone: any[];

  beforeEach(() => {
    everyone = [person(ANNA, 'Anna', ENG), person(BEN, 'Ben', OPS), person(CARA, 'Cara', ENG)];
    notices = [];
    docModel = { findOne: jest.fn().mockResolvedValue(doc()), findAll: jest.fn().mockResolvedValue([]) };
    ackModel = { findAll: jest.fn().mockResolvedValue([]), findOrCreate: jest.fn() };
    noticeModel = { findAll: jest.fn().mockResolvedValue([]), bulkCreate: jest.fn().mockResolvedValue([]) };
    employeeModel = {
      findAll: jest.fn(async ({ where }: any) => {
        // Honour the audience the way the database would.
        const clauses = where[Op.or];
        if (!clauses) return everyone;
        return everyone.filter((p) =>
          clauses.some((c: any) => (c.departmentId ? c.departmentId[Op.in].includes(p.departmentId) : c.id[Op.in].includes(p.id))),
        );
      }),
      findOne: jest.fn().mockResolvedValue({ id: ANNA, departmentId: ENG }),
      count: jest.fn(async ({ where }: any) => where.id[Op.in].length),
    };
    departmentModel = {
      findAll: jest.fn().mockResolvedValue([{ id: ENG, name: 'Engineering' }, { id: OPS, name: 'Operations' }]),
      count: jest.fn(async ({ where }: any) => where.id[Op.in].length),
    };
    auditModel = { create: jest.fn().mockResolvedValue({}) };
    const provider: any = {
      getCompanyDocumentModel: async () => docModel,
      getCompanyDocumentAcknowledgementModel: async () => ackModel,
      getCompanyDocumentAckNoticeModel: async () => noticeModel,
      getEmployeeModel: async () => employeeModel,
      getDepartmentModel: async () => departmentModel,
      getEmployeeNotificationModel: async () => ({ bulkCreate: jest.fn(async (rows: any[]) => notices.push(...rows)) }),
      getEntityAuditLogModel: async () => auditModel,
    };
    service = new PolicyAcknowledgementService(provider);
  });

  describe('sending a document', () => {
    it('turns acknowledgement on for a published document and asks everyone in the audience', async () => {
      const draftless = doc({ requiresAcknowledgement: false });
      docModel.findOne.mockResolvedValue(draftless);

      const view = await service.setDistribution(actor, DOC, { requiresAcknowledgement: true, audience: { departmentIds: [ENG] }, acknowledgeBy: addDays(today, 10) });

      expect(draftless.update).toHaveBeenCalledWith({ requiresAcknowledgement: true, audience: { departmentIds: [ENG], employeeIds: [] }, acknowledgeBy: addDays(today, 10) });
      expect(notices.map((n) => n.employeeId).sort()).toEqual([ANNA, CARA].sort());
      expect(notices[0]).toMatchObject({ kind: 'POLICY', title: 'Policy to acknowledge: Code of Conduct' });
      expect(view).toMatchObject({ requiresAcknowledgement: true, audienceCount: 2, acknowledged: 0, pending: 2, overdue: 0, version: 1 });
      expect(auditModel.create).toHaveBeenCalled();
    });

    it('asks only the people newly reached when the audience grows', async () => {
      const sent = doc({ audience: { departmentIds: [ENG], employeeIds: [] } });
      docModel.findOne.mockResolvedValue(sent);

      await service.setDistribution(actor, DOC, { audience: { departmentIds: [ENG, OPS] } });

      expect(notices.map((n) => n.employeeId)).toEqual([BEN]);
    });

    it('widening to everyone reaches the rest', async () => {
      docModel.findOne.mockResolvedValue(doc({ audience: { departmentIds: [ENG], employeeIds: [] } }));
      await service.setDistribution(actor, DOC, { audience: null });
      expect(notices.map((n) => n.employeeId)).toEqual([BEN]);
    });

    it('sends nothing for a draft, and nothing when acknowledgement is not asked for', async () => {
      docModel.findOne.mockResolvedValue(doc({ status: 'DRAFT', requiresAcknowledgement: false }));
      await service.setDistribution(actor, DOC, { requiresAcknowledgement: true });
      expect(notices).toHaveLength(0);

      docModel.findOne.mockResolvedValue(doc({ requiresAcknowledgement: false }));
      await service.setDistribution(actor, DOC, { audience: { departmentIds: [OPS] } });
      expect(notices).toHaveLength(0);
    });

    it('refuses a past deadline, a deadline without acknowledgement, and people who do not exist', async () => {
      await expect(service.setDistribution(actor, DOC, { acknowledgeBy: addDays(today, -1) })).rejects.toMatchObject({ status: 400 });

      docModel.findOne.mockResolvedValue(doc({ requiresAcknowledgement: false }));
      await expect(service.setDistribution(actor, DOC, { acknowledgeBy: addDays(today, 5) })).rejects.toMatchObject({ status: 400 });

      docModel.findOne.mockResolvedValue(doc());
      departmentModel.count.mockResolvedValue(0);
      await expect(service.setDistribution(actor, DOC, { audience: { departmentIds: [ENG] } })).rejects.toMatchObject({ status: 400 });
    });

    it('404s for a document that is not there', async () => {
      docModel.findOne.mockResolvedValue(null);
      await expect(service.setDistribution(actor, DOC, {})).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('asking again', () => {
    it('raises the version and asks everyone who has not acknowledged that version', async () => {
      const current = doc({ acknowledgementVersion: 2 });
      docModel.findOne.mockResolvedValue(current);
      ackModel.findAll.mockResolvedValue([{ employeeId: ANNA, acknowledgedAt: new Date() }]);

      await service.requestReacknowledgement(actor, DOC);

      expect(current.update).toHaveBeenCalledWith({ acknowledgementVersion: 3 });
      expect(ackModel.findAll.mock.calls[0][0].where.version).toBe(3);
      expect(notices[0].title).toBe('Please acknowledge again: Code of Conduct');
    });

    it('needs a published document that asks for acknowledgement', async () => {
      docModel.findOne.mockResolvedValue(doc({ requiresAcknowledgement: false }));
      await expect(service.requestReacknowledgement(actor, DOC)).rejects.toMatchObject({ status: 409 });
      docModel.findOne.mockResolvedValue(doc({ status: 'DRAFT' }));
      await expect(service.requestReacknowledgement(actor, DOC)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('who has acknowledged', () => {
    it('lists the audience with a status for each and counts that ignore the filter', async () => {
      docModel.findOne.mockResolvedValue(doc({ acknowledgeBy: addDays(today, -2) }));
      ackModel.findAll.mockResolvedValue([{ employeeId: ANNA, acknowledgedAt: new Date('2026-10-05') }]);

      const all = await service.getAcknowledgements(TENANT, DOC, {});

      expect(all.summary).toEqual({ audience: 3, acknowledged: 1, pending: 0, overdue: 2 });
      expect(all.data.map((r) => [r.employee.name, r.status])).toEqual([
        ['Anna Khan', 'ACKNOWLEDGED'],
        ['Ben Khan', 'OVERDUE'],
        ['Cara Khan', 'OVERDUE'],
      ]);
      expect(all.data[0].employee.department).toBe('Engineering');

      const overdue = await service.getAcknowledgements(TENANT, DOC, { status: 'OVERDUE' as any, search: 'ben' });
      expect(overdue.data.map((r) => r.employee.name)).toEqual(['Ben Khan']);
      expect(overdue.total).toBe(1);
    });

    it('is pending, not overdue, before the deadline or with none', async () => {
      docModel.findOne.mockResolvedValue(doc({ acknowledgeBy: addDays(today, 3) }));
      expect((await service.getAcknowledgements(TENANT, DOC, {})).summary).toMatchObject({ pending: 3, overdue: 0 });
    });

    it('only counts the current version', async () => {
      docModel.findOne.mockResolvedValue(doc({ acknowledgementVersion: 4 }));
      await service.getAcknowledgements(TENANT, DOC, {});
      expect(ackModel.findAll.mock.calls[0][0].where.version).toBe(4);
    });

    it('summarizes the documents that ask for acknowledgement', async () => {
      docModel.findAll.mockResolvedValue([doc({ acknowledgeBy: addDays(today, -1) }), doc({ id: 'd2', name: 'Handbook', category: 'HANDBOOK' })]);
      ackModel.findAll.mockResolvedValue([{ employeeId: ANNA, acknowledgedAt: new Date() }]);

      const result = await service.overview(TENANT);

      expect(docModel.findAll.mock.calls[0][0].where).toMatchObject({ status: 'PUBLISHED', requiresAcknowledgement: true });
      expect(result.data[0]).toMatchObject({ name: 'Code of Conduct', audienceCount: 3, acknowledged: 1, pending: 0, overdue: 2 });
      expect(result.data[1]).toMatchObject({ name: 'Handbook', acknowledged: 1, pending: 2, overdue: 0 });
      expect(result.summary).toEqual({ documents: 2, pending: 2, overdue: 2 });
    });

    it('reminds only those who have not acknowledged', async () => {
      ackModel.findAll.mockResolvedValue([{ employeeId: ANNA, acknowledgedAt: new Date() }]);
      expect(await service.remind(actor, DOC)).toEqual({ reminded: 2 });
      expect(notices.map((n) => n.title)).toEqual(['Reminder: Code of Conduct', 'Reminder: Code of Conduct']);
    });
  });

  describe('My Policies', () => {
    it('shows what is meant for me, with my acknowledgement, those waiting first', async () => {
      docModel.findAll.mockResolvedValue([
        doc({ id: 'd-handbook', name: 'Handbook', category: 'HANDBOOK', requiresAcknowledgement: false }),
        doc({ id: 'd-conduct', acknowledgeBy: addDays(today, -1) }),
        doc({ id: 'd-ops', name: 'Ops only', audience: { departmentIds: [OPS], employeeIds: [] } }),
        doc({ id: 'd-done', name: 'Security', acknowledgementVersion: 2 }),
      ]);
      ackModel.findAll.mockResolvedValue([
        { documentId: 'd-done', version: 2, acknowledgedAt: new Date('2026-10-20') },
        { documentId: 'd-conduct', version: 0, acknowledgedAt: new Date('2026-01-01') },
      ]);

      const { data, summary } = await service.getMine(actor, {});

      expect(data.map((r) => r.id)).toEqual(['d-conduct', 'd-handbook', 'd-done']);
      expect(data[0]).toMatchObject({ requiresAcknowledgement: true, acknowledged: false, overdue: true });
      expect(data[1]).toMatchObject({ requiresAcknowledgement: false, acknowledged: null, overdue: false });
      expect(data[2]).toMatchObject({ acknowledged: true, acknowledgedAt: new Date('2026-10-20') });
      expect(summary).toEqual({ total: 3, pending: 1, overdue: 1, acknowledged: 1 });
    });

    it('filters to what is waiting, or done, and searches by name', async () => {
      docModel.findAll.mockResolvedValue([doc({ id: 'a', name: 'Alpha' }), doc({ id: 'b', name: 'Beta' })]);
      ackModel.findAll.mockResolvedValue([{ documentId: 'b', version: 1, acknowledgedAt: new Date() }]);

      expect((await service.getMine(actor, { status: 'PENDING' as any })).data.map((r) => r.id)).toEqual(['a']);
      expect((await service.getMine(actor, { status: 'ACKNOWLEDGED' as any })).data.map((r) => r.id)).toEqual(['b']);
      expect((await service.getMine(actor, { search: 'bet' })).data.map((r) => r.id)).toEqual(['b']);
    });

    it('says so when no employee is linked to the login', async () => {
      employeeModel.findOne.mockResolvedValue(null);
      await expect(service.getMine(actor, {})).rejects.toMatchObject({ status: 404 });
    });

    it('records my acknowledgement of the current version once', async () => {
      const at = new Date('2026-11-03');
      ackModel.findOrCreate.mockResolvedValue([{ id: 'ack-1', acknowledgedAt: at }, true]);

      const result = await service.acknowledge(actor, DOC);

      expect(ackModel.findOrCreate.mock.calls[0][0].where).toEqual({ tenantId: TENANT, documentId: DOC, employeeId: ANNA, version: 1 });
      expect(result).toMatchObject({ id: DOC, acknowledged: true, acknowledgedAt: at });
      expect(auditModel.create.mock.calls[0][0]).toMatchObject({ tableName: 'company_document_acknowledgements', action: 'CREATE' });

      auditModel.create.mockClear();
      ackModel.findOrCreate.mockResolvedValue([{ id: 'ack-1', acknowledgedAt: at }, false]);
      await service.acknowledge(actor, DOC);
      expect(auditModel.create).not.toHaveBeenCalled();
    });

    it('cannot acknowledge a document that is not meant for me, not published, or does not ask', async () => {
      docModel.findOne.mockResolvedValue(doc({ audience: { departmentIds: [OPS], employeeIds: [] } }));
      await expect(service.acknowledge(actor, DOC)).rejects.toMatchObject({ status: 404 });
      docModel.findOne.mockResolvedValue(doc({ status: 'DRAFT' }));
      await expect(service.acknowledge(actor, DOC)).rejects.toMatchObject({ status: 404 });
      docModel.findOne.mockResolvedValue(doc({ requiresAcknowledgement: false }));
      await expect(service.acknowledge(actor, DOC)).rejects.toMatchObject({ status: 409 });
      expect(ackModel.findOrCreate).not.toHaveBeenCalled();
    });

    it('treats a login with no employee as someone no audience includes', async () => {
      employeeModel.findOne.mockResolvedValue(null);
      expect(await service.viewerOf(TENANT, 'u', 'x@example.com')).toBeNull();
    });
  });

  describe('deadline reminders', () => {
    it('tells people who have not acknowledged once the deadline is near, and stamps it', async () => {
      docModel.findAll.mockResolvedValue([doc({ acknowledgeBy: addDays(today, 2) })]);
      ackModel.findAll.mockResolvedValue([{ employeeId: ANNA, acknowledgedAt: new Date() }]);

      expect(await service.sendReminders(TENANT, today)).toBe(2);

      expect(notices.map((n) => n.employeeId).sort()).toEqual([BEN, CARA].sort());
      expect(notices[0].title).toContain('Acknowledge by');
      const stamped = noticeModel.bulkCreate.mock.calls[0][0];
      expect(stamped).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: DOC, version: 1, kind: 'DUE_SOON' })]));
      expect(docModel.findAll.mock.calls[0][0].where.acknowledgeBy[Op.lte]).toBe(addDays(today, 3));
    });

    it('sends an overdue notice after the deadline, and nobody twice', async () => {
      docModel.findAll.mockResolvedValue([doc({ acknowledgeBy: addDays(today, -1) })]);
      noticeModel.findAll.mockResolvedValue([{ employeeId: ANNA }, { employeeId: BEN }]);

      expect(await service.sendReminders(TENANT, today)).toBe(1);

      expect(notices.map((n) => [n.employeeId, n.title])).toEqual([[CARA, 'Acknowledgement overdue: Code of Conduct']]);
      expect(noticeModel.findAll.mock.calls[0][0].where).toMatchObject({ documentId: DOC, version: 1, kind: 'OVERDUE' });
    });

    it('stamps nothing when the notices could not be saved, so the next run tries again', async () => {
      docModel.findAll.mockResolvedValue([doc({ acknowledgeBy: addDays(today, 1) })]);
      (service as any).modelProvider.getEmployeeNotificationModel = async () => ({
        bulkCreate: jest.fn().mockRejectedValue(new Error('db down')),
      });

      expect(await service.sendReminders(TENANT, today)).toBe(0);
      expect(noticeModel.bulkCreate).not.toHaveBeenCalled();
    });
  });
});
