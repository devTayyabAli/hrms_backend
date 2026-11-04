import { AssetStatus } from '@app/common';
import { AssetSelfService } from './asset-self.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AYESHA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const ASSET = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const actor = { tenantId: TENANT, userId: 'user-ayesha', email: 'ayesha@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const asset = (over: Record<string, any> = {}) =>
  row({
    id: ASSET,
    assetCode: 'AST-0001',
    name: 'MacBook Pro 14"',
    status: AssetStatus.IN_USE,
    assignedEmployeeId: AYESHA,
    assignedAt: new Date('2026-10-01T00:00:00Z'),
    acceptedAt: null,
    acceptedSignature: null,
    brand: 'Apple',
    serialNumber: 'SN1',
    specifications: [{ key: 'RAM', value: '16 GB' }],
    warrantyExpiry: '2029-03-15',
    category: { id: 'c1', name: 'Laptop', icon: 'laptop' },
    ...over,
  });

describe('AssetSelfService', () => {
  let employeeModel: any;
  let assetModel: any;
  let eventModel: any;
  let requestModel: any;
  let service: AssetSelfService;

  beforeEach(() => {
    employeeModel = { findOne: jest.fn().mockResolvedValue({ id: AYESHA, firstName: 'Ayesha', lastName: 'Khan' }) };
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    assetModel = {
      sequelize: { transaction: jest.fn(async (work: (t: unknown) => unknown) => work(transaction)) },
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    eventModel = { create: jest.fn().mockResolvedValue({}) };
    requestModel = { findAll: jest.fn().mockResolvedValue([]) };
    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getAssetModel: jest.fn().mockResolvedValue(assetModel),
      getAssetCategoryModel: jest.fn().mockResolvedValue({}),
      getAssetEventModel: jest.fn().mockResolvedValue(eventModel),
      getAssetRequestModel: jest.fn().mockResolvedValue(requestModel),
    };
    service = new AssetSelfService(provider);
  });

  describe('who is asking', () => {
    it('finds the employee by login id, then by email', async () => {
      employeeModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: AYESHA, firstName: 'Ayesha', lastName: 'Khan' });

      await expect(service.me(actor)).resolves.toMatchObject({ id: AYESHA });
      expect(employeeModel.findOne).toHaveBeenCalledTimes(2);
    });

    it('404s for a login with no employee profile', async () => {
      employeeModel.findOne.mockResolvedValue(null);

      await expect(service.getMyAssets(actor)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('my assets', () => {
    it('lists only my assets and puts what still needs my signature first', async () => {
      assetModel.findAll.mockResolvedValue([
        asset({ id: 'signed', acceptedAt: new Date('2026-10-02'), acceptedSignature: 'Ayesha Khan' }),
        asset({ id: 'unsigned' }),
        asset({ id: 'repair', status: AssetStatus.MAINTENANCE }),
      ]);
      requestModel.findAll.mockResolvedValue([{ assetId: 'repair' }, { assetId: 'repair' }]);

      const result = await service.getMyAssets(actor);

      expect(assetModel.findAll.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, assignedEmployeeId: AYESHA });
      expect(result.data.map((row) => [row.id, row.acceptance.status])).toEqual([
        ['unsigned', 'PENDING'],
        ['signed', 'ACCEPTED'],
        ['repair', null],
      ]);
      expect(result.data[1].acceptance.signedName).toBe('Ayesha Khan');
      expect(result.data[2].openRequests).toBe(2);
      expect(result.summary).toEqual({ total: 3, pendingAcceptance: 1 });
      expect(result.data[0]).toMatchObject({ assetCode: 'AST-0001', category: { name: 'Laptop' }, specifications: [{ key: 'RAM', value: '16 GB' }], warrantyExpiry: '2029-03-15' });
    });

    it('is empty for someone with no assets', async () => {
      const result = await service.getMyAssets(actor);

      expect(result).toEqual({ data: [], summary: { total: 0, pendingAcceptance: 0 } });
      expect(requestModel.findAll).not.toHaveBeenCalled();
    });
  });

  describe('signing for an asset', () => {
    it('records the signature and the acknowledgement, whatever the case or spacing of the typed name', async () => {
      const mine = asset();
      assetModel.findOne.mockResolvedValue(mine);

      await service.acceptHandover(actor, ASSET, { confirmed: true, signature: '  AYESHA    khan ' });

      expect(assetModel.findOne.mock.calls[0][0].where).toEqual({ id: ASSET, tenantId: TENANT, assignedEmployeeId: AYESHA });
      expect(mine.update.mock.calls[0][0]).toMatchObject({ acceptedSignature: 'AYESHA khan' });
      expect(mine.update.mock.calls[0][0].acceptedAt).toBeInstanceOf(Date);
      expect(eventModel.create.mock.calls[0][0]).toMatchObject({
        type: 'ACCEPTED',
        assetId: ASSET,
        employeeId: AYESHA,
        employeeName: 'Ayesha Khan',
        toStatus: 'IN_USE',
        details: { signedName: 'AYESHA khan', confirmedWorkingOrder: true },
        actorEmail: 'ayesha@example.com',
      });
    });

    it('will not take a signature that is not the employee\'s own name', async () => {
      await expect(service.acceptHandover(actor, ASSET, { confirmed: true, signature: 'Bilal Ahmed' })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('Ayesha Khan'),
      });
      expect(assetModel.findOne).not.toHaveBeenCalled();
    });

    it('needs the confirmation, and points to a repair request if the asset is not fine', async () => {
      await expect(service.acceptHandover(actor, ASSET, { confirmed: false, signature: 'Ayesha Khan' })).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('repair request'),
      });
    });

    it('treats someone else\'s asset as not found', async () => {
      assetModel.findOne.mockResolvedValue(null);

      await expect(service.acceptHandover(actor, ASSET, { confirmed: true, signature: 'Ayesha Khan' })).rejects.toMatchObject({ status: 404 });
      expect(eventModel.create).not.toHaveBeenCalled();
    });

    it('will not sign twice, or for an asset that is away or lost', async () => {
      assetModel.findOne.mockResolvedValue(asset({ acceptedAt: new Date() }));
      await expect(service.acceptHandover(actor, ASSET, { confirmed: true, signature: 'Ayesha Khan' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already signed') });

      for (const status of [AssetStatus.MAINTENANCE, AssetStatus.LOST, AssetStatus.DAMAGED]) {
        assetModel.findOne.mockResolvedValue(asset({ status }));
        await expect(service.acceptHandover(actor, ASSET, { confirmed: true, signature: 'Ayesha Khan' })).rejects.toMatchObject({ status: 409 });
      }
      expect(eventModel.create).not.toHaveBeenCalled();
    });
  });
});
