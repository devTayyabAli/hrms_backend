import { CompanyDocumentService } from './company-document.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOC = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0';
const ENG = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const OPS = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';

const record = (over: Record<string, any> = {}) => {
  const r: any = {
    id: DOC,
    tenantId: TENANT,
    name: 'Code of Conduct',
    category: 'POLICY',
    status: 'PUBLISHED',
    owner: null,
    description: null,
    fileId: 'file-1',
    fileName: 'conduct.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    publishedAt: new Date('2026-10-01'),
    requiresAcknowledgement: false,
    audience: null,
    acknowledgeBy: null,
    acknowledgementVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  r.get = () => ({ ...r });
  r.update = jest.fn(async (patch: any) => Object.assign(r, patch));
  return r;
};

describe('CompanyDocumentService: distribution', () => {
  let docModel: any;
  let acknowledgements: { viewerOf: jest.Mock; announce: jest.Mock };
  let service: CompanyDocumentService;
  let current: any;

  beforeEach(() => {
    current = record();
    docModel = { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn(async () => current) };
    acknowledgements = { viewerOf: jest.fn().mockResolvedValue({ id: 'me', departmentId: ENG }), announce: jest.fn().mockResolvedValue(0) };
    const provider: any = {
      getCompanyDocumentModel: async () => docModel,
      getEmployeeModel: async () => ({}),
      getDepartmentModel: async () => ({}),
      getEntityAuditLogModel: async () => ({ create: jest.fn().mockResolvedValue({}) }),
    };
    service = new CompanyDocumentService(provider, acknowledgements as any);
  });

  describe('the employee view', () => {
    it('shows everyone the documents sent to everyone, and only the audience the others', async () => {
      docModel.findAll.mockResolvedValue([
        record({ id: 'all', name: 'Handbook' }),
        record({ id: 'eng', name: 'Engineering only', audience: { departmentIds: [ENG], employeeIds: [] } }),
        record({ id: 'ops', name: 'Operations only', audience: { departmentIds: [OPS], employeeIds: [] } }),
      ]);

      const { data } = await service.getPublished(TENANT, {}, { userId: 'u', email: 'me@example.com' });

      expect(data.map((row) => row.id)).toEqual(['all', 'eng']);
    });

    it('does not show the audience itself to the employee', async () => {
      docModel.findAll.mockResolvedValue([record({ id: 'eng', audience: { departmentIds: [ENG], employeeIds: [] } })]);
      const { data } = await service.getPublished(TENANT, {}, { userId: 'u' });
      expect(data[0].audience).toBeNull();
    });

    it('shows only the documents for everyone to a login with no employee profile', async () => {
      acknowledgements.viewerOf.mockResolvedValue(null);
      docModel.findAll.mockResolvedValue([record({ id: 'all' }), record({ id: 'eng', audience: { departmentIds: [ENG], employeeIds: [] } })]);
      expect((await service.getPublished(TENANT, {}, { userId: 'u' })).data.map((row) => row.id)).toEqual(['all']);
    });
  });

  describe('the library', () => {
    it('shows how each document is sent', async () => {
      docModel.findAll.mockResolvedValue([record({ requiresAcknowledgement: true, acknowledgeBy: '2026-12-15', acknowledgementVersion: 3, audience: { departmentIds: [ENG], employeeIds: [] } })]);
      docModel.count = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(0);

      const { data } = await service.getAll(TENANT, {});

      expect(data[0]).toMatchObject({ requiresAcknowledgement: true, acknowledgeBy: '2026-12-15', acknowledgementVersion: 3, audience: { departmentIds: [ENG], employeeIds: [] } });
    });
  });

  describe('replacing the file', () => {
    const replace = { fileId: 'file-2', fileName: 'conduct-v2.pdf', sizeBytes: 120 };

    it('makes a new version of a published document that asks for acknowledgement, and asks again', async () => {
      current = record({ requiresAcknowledgement: true, acknowledgementVersion: 2 });

      await service.update(TENANT, DOC, replace as any);

      expect(current.update.mock.calls[0][0]).toMatchObject({ fileId: 'file-2', acknowledgementVersion: 3 });
      expect(acknowledgements.announce).toHaveBeenCalledWith(TENANT, current, undefined, 'Please acknowledge again');
    });

    it('leaves the version alone when acknowledgement is not asked for, or the document is a draft', async () => {
      current = record({ requiresAcknowledgement: false });
      await service.update(TENANT, DOC, replace as any);
      expect(current.update.mock.calls[0][0].acknowledgementVersion).toBeUndefined();

      current = record({ requiresAcknowledgement: true, status: 'DRAFT' });
      await service.update(TENANT, DOC, replace as any);
      expect(current.update.mock.calls[0][0].acknowledgementVersion).toBeUndefined();
      expect(acknowledgements.announce).not.toHaveBeenCalled();
    });
  });

  describe('publishing', () => {
    it('asks the audience when a draft that asks for acknowledgement is published', async () => {
      current = record({ status: 'DRAFT', requiresAcknowledgement: true });

      await service.update(TENANT, DOC, { status: 'PUBLISHED' } as any);

      expect(acknowledgements.announce).toHaveBeenCalledWith(TENANT, current, undefined, 'Policy to acknowledge');
    });

    it('says nothing when an edit does not publish it', async () => {
      current = record({ requiresAcknowledgement: true });
      await service.update(TENANT, DOC, { name: 'Renamed' } as any);
      expect(acknowledgements.announce).not.toHaveBeenCalled();
    });
  });
});
