import { Op } from 'sequelize';
import { AssetRequestDecision, AssetRequestType, AssetStatus } from '@app/common';
import { AssetRequestService } from './asset-request.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AYESHA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const ASSET = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const REQUEST = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const actor = { tenantId: TENANT, userId: 'user-ayesha', email: 'ayesha@example.com' };
const admin = { tenantId: TENANT, userId: 'user-admin', email: 'it@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const request = (over: Record<string, any> = {}) =>
  row({
    id: REQUEST,
    type: 'REPAIR',
    status: 'OPEN',
    description: 'Screen flickers',
    resolutionNote: null,
    handledBy: null,
    resolvedAt: null,
    createdAt: new Date('2026-10-10T00:00:00Z'),
    asset: { id: ASSET, assetCode: 'AST-0001', name: 'MacBook', serialNumber: 'SN1', status: 'IN_USE' },
    employee: { id: AYESHA, firstName: 'Ayesha', lastName: 'Khan', employeeCode: 'EMP-1' },
    ...over,
  });

describe('AssetRequestService', () => {
  let assetModel: any;
  let requestModel: any;
  let flagModel: any;
  let service: AssetRequestService;

  beforeEach(() => {
    assetModel = { findOne: jest.fn().mockResolvedValue({ id: ASSET, status: AssetStatus.IN_USE }) };
    requestModel = {
      sequelize: { query: jest.fn().mockResolvedValue([]) },
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      create: jest.fn(async (values: any) => row({ id: REQUEST, ...values })),
      count: jest.fn().mockResolvedValue(0),
    };
    flagModel = { count: jest.fn().mockResolvedValue(0) };
    const provider: any = {
      getAssetModel: jest.fn().mockResolvedValue(assetModel),
      getAssetRequestModel: jest.fn().mockResolvedValue(requestModel),
      getAssetDeductionFlagModel: jest.fn().mockResolvedValue(flagModel),
      getEmployeeModel: jest.fn().mockResolvedValue({}),
    };
    const self: any = { me: jest.fn().mockResolvedValue({ id: AYESHA, firstName: 'Ayesha', lastName: 'Khan' }) };
    service = new AssetRequestService(provider, self);
  });

  describe('an employee raising a request', () => {
    it('creates a request for one of their own assets', async () => {
      requestModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(request());

      const result = await service.createMyRequest(actor, { assetId: ASSET, type: AssetRequestType.REPAIR, description: '  Screen flickers ' });

      expect(assetModel.findOne.mock.calls[0][0].where).toEqual({ id: ASSET, tenantId: TENANT, assignedEmployeeId: AYESHA });
      expect(requestModel.create.mock.calls[0][0]).toMatchObject({ assetId: ASSET, employeeId: AYESHA, type: 'REPAIR', status: 'OPEN', description: 'Screen flickers' });
      expect(result).toMatchObject({ id: REQUEST, status: 'OPEN', asset: { assetCode: 'AST-0001' }, employee: { name: 'Ayesha Khan' } });
    });

    it('treats an asset that is not theirs as not found', async () => {
      assetModel.findOne.mockResolvedValue(null);

      await expect(service.createMyRequest(actor, { assetId: ASSET, type: AssetRequestType.REPAIR, description: 'Broken' })).rejects.toMatchObject({ status: 404 });
      expect(requestModel.create).not.toHaveBeenCalled();
    });

    it('refuses a second open request of the same kind for the asset', async () => {
      requestModel.findOne.mockResolvedValue({ id: 'existing' });

      await expect(service.createMyRequest(actor, { assetId: ASSET, type: AssetRequestType.REPAIR, description: 'Broken again' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('already have an open request'),
      });
    });

    it('lists their own requests with how many are still open', async () => {
      requestModel.findAll.mockResolvedValue([request(), request({ id: 'r2', status: 'RESOLVED' }), request({ id: 'r3', status: 'IN_PROGRESS' })]);

      const result = await service.getMyRequests(actor);

      expect(requestModel.findAll.mock.calls[0][0].where).toEqual({ tenantId: TENANT, employeeId: AYESHA });
      expect(result.data).toHaveLength(3);
      expect(result.summary).toEqual({ open: 2 });
    });
  });

  describe('the IT / Admin queue', () => {
    it('pages, filters and counts per status', async () => {
      requestModel.findAndCountAll.mockResolvedValue({ rows: [request()], count: 14 });
      requestModel.sequelize.query.mockResolvedValue([
        { status: 'OPEN', count: 5 },
        { status: 'IN_PROGRESS', count: 2 },
        { status: 'RESOLVED', count: 7 },
      ]);

      const result = await service.getRequests(TENANT, { status: 'OPEN' as any, type: AssetRequestType.REPAIR, search: 'flicker', page: 2, limit: 5 });

      const options = requestModel.findAndCountAll.mock.calls[0][0];
      expect(options).toMatchObject({ limit: 5, offset: 5 });
      expect(options.where).toMatchObject({ tenantId: TENANT, status: 'OPEN', type: 'REPAIR' });
      expect(options.where[Op.or].map((clause: any) => Object.keys(clause)[0])).toEqual(
        expect.arrayContaining(['description', '$employee.firstName$', '$asset.assetCode$', '$asset.serialNumber$']),
      );
      expect(result).toMatchObject({ total: 14, page: 2, limit: 5, totalPages: 3 });
      expect(result.summary).toEqual({ open: 5, inProgress: 2, resolved: 7, rejected: 0 });
    });

    it('does not filter on status for ALL', async () => {
      await service.getRequests(TENANT, { status: 'ALL' as any });

      expect(requestModel.findAndCountAll.mock.calls[0][0].where.status).toBeUndefined();
    });
  });

  describe('the notification bell', () => {
    it('counts what is waiting and names the newest request', async () => {
      requestModel.count.mockImplementation(async ({ where }: any) => (where.status === 'OPEN' ? 3 : 2));
      flagModel.count.mockResolvedValue(4);
      requestModel.findOne.mockResolvedValue(request());

      const result = await service.getAlerts(TENANT);

      expect(flagModel.count.mock.calls[0][0].where).toEqual({ tenantId: TENANT, status: 'PENDING' });
      expect(result).toMatchObject({
        openRequests: 3,
        inProgressRequests: 2,
        pendingDeductions: 4,
        latestRequest: { id: REQUEST, type: 'REPAIR', employee: { name: 'Ayesha Khan' }, asset: { assetCode: 'AST-0001' } },
      });
      expect(requestModel.findOne.mock.calls[0][0]).toMatchObject({ where: { tenantId: TENANT, status: 'OPEN' }, order: [['createdAt', 'DESC']] });
    });

    it('has no newest request when nothing is waiting', async () => {
      const result = await service.getAlerts(TENANT);

      expect(result).toEqual({ openRequests: 0, inProgressRequests: 0, pendingDeductions: 0, latestRequest: null });
    });
  });

  describe('working a request', () => {
    const decide = async (current: Record<string, any>, dto: any) => {
      const found = request(current);
      requestModel.findOne.mockResolvedValueOnce(found).mockResolvedValue(found);
      await service.updateRequest(admin, REQUEST, dto);
      return found;
    };

    it('takes an open request in progress, without closing it', async () => {
      const found = await decide({}, { status: AssetRequestDecision.IN_PROGRESS });

      expect(found.update.mock.calls[0][0]).toMatchObject({ status: 'IN_PROGRESS', handledBy: 'it@example.com', resolvedAt: null });
    });

    it('resolves a request with a note and stamps when', async () => {
      const found = await decide({ status: 'IN_PROGRESS' }, { status: AssetRequestDecision.RESOLVED, resolutionNote: 'Screen replaced' });

      const patch = found.update.mock.calls[0][0];
      expect(patch).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Screen replaced' });
      expect(patch.resolvedAt).toBeInstanceOf(Date);
    });

    it('needs a reason to reject', async () => {
      requestModel.findOne.mockResolvedValue(request());

      await expect(service.updateRequest(admin, REQUEST, { status: AssetRequestDecision.REJECTED })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('why') });
    });

    it('cannot change a request that is resolved or rejected, or move one already in progress to in progress', async () => {
      requestModel.findOne.mockResolvedValue(request({ status: 'RESOLVED' }));
      await expect(service.updateRequest(admin, REQUEST, { status: AssetRequestDecision.IN_PROGRESS })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('resolved') });

      requestModel.findOne.mockResolvedValue(request({ status: 'REJECTED' }));
      await expect(service.updateRequest(admin, REQUEST, { status: AssetRequestDecision.RESOLVED })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('rejected') });

      requestModel.findOne.mockResolvedValue(request({ status: 'IN_PROGRESS' }));
      await expect(service.updateRequest(admin, REQUEST, { status: AssetRequestDecision.IN_PROGRESS })).rejects.toMatchObject({ status: 409 });
    });

    it('404s for a request that is not in this organization', async () => {
      await expect(service.updateRequest(admin, REQUEST, { status: AssetRequestDecision.RESOLVED })).rejects.toMatchObject({ status: 404 });
    });
  });
});
