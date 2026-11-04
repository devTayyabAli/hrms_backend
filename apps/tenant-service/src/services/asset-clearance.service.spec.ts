import { PayrollAdjustmentType } from '@app/common';
import { AssetClearanceService } from './asset-clearance.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AYESHA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const ASSET = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const FLAG = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';
const admin = { tenantId: TENANT, userId: 'user-admin', email: 'it@example.com' };

const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  return r;
};

const ayesha = () => ({ id: AYESHA, firstName: 'Ayesha', lastName: 'Khan', employeeCode: 'EMP-1', status: 'ACTIVE', exitDate: null });
const heldAsset = (over: Record<string, any> = {}) => ({
  id: ASSET,
  assetCode: 'AST-0001',
  name: 'MacBook',
  serialNumber: 'SN1',
  status: 'IN_USE',
  assignedAt: new Date('2026-09-01'),
  category: { id: 'c1', name: 'Laptop' },
  ...over,
});
const flag = (over: Record<string, any> = {}) =>
  row({
    id: FLAG,
    employeeId: AYESHA,
    reason: 'LOST',
    status: 'PENDING',
    suggestedAmount: '1899.50',
    amount: null,
    createdAt: new Date('2026-10-05'),
    asset: { id: ASSET, assetCode: 'AST-0001', name: 'MacBook', purchaseCost: '1899.50' },
    employee: { id: AYESHA, firstName: 'Ayesha', lastName: 'Khan', employeeCode: 'EMP-1' },
    ...over,
  });

describe('AssetClearanceService', () => {
  let employeeModel: any;
  let assetModel: any;
  let flagModel: any;
  let clearanceModel: any;
  let eventModel: any;
  let runModel: any;
  let adjustmentModel: any;
  let service: AssetClearanceService;

  /** What the asset history says about the employee: how many events, and when the last one was. */
  const history = (count: number, last: string | null) => eventModel.sequelize.query.mockResolvedValue([{ count, last }]);

  beforeEach(() => {
    employeeModel = { findOne: jest.fn().mockResolvedValue(ayesha()) };
    assetModel = { findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    flagModel = {
      findAll: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    };
    clearanceModel = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
    eventModel = { sequelize: { query: jest.fn().mockResolvedValue([{ count: 0, last: null }]) } };
    runModel = { findOne: jest.fn().mockResolvedValue(null) };
    adjustmentModel = { create: jest.fn(async (values: any) => ({ id: 'adj-1', ...values })) };
    const provider: any = {
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
      getAssetModel: jest.fn().mockResolvedValue(assetModel),
      getAssetCategoryModel: jest.fn().mockResolvedValue({}),
      getAssetDeductionFlagModel: jest.fn().mockResolvedValue(flagModel),
      getAssetClearanceModel: jest.fn().mockResolvedValue(clearanceModel),
      getAssetEventModel: jest.fn().mockResolvedValue(eventModel),
      getPayrollRunModel: jest.fn().mockResolvedValue(runModel),
      getPayrollAdjustmentModel: jest.fn().mockResolvedValue(adjustmentModel),
    };
    service = new AssetClearanceService(provider);
  });

  describe('where a leaving employee stands', () => {
    it('is clear for someone who never had an asset', async () => {
      const result = await service.getClearance(TENANT, AYESHA);

      expect(result).toMatchObject({ cleared: true, readyToConfirm: false, hasAssetHistory: false, blockers: [] });
    });

    it('is blocked while they still have assets, naming them', async () => {
      assetModel.findAll.mockResolvedValue([heldAsset(), heldAsset({ id: 'a2', assetCode: 'AST-0002' })]);
      history(2, '2026-09-01T00:00:00Z');

      const result = await service.getClearance(TENANT, AYESHA);

      expect(result.cleared).toBe(false);
      expect(result.readyToConfirm).toBe(false);
      expect(result.assets.map((asset) => asset.assetCode)).toEqual(['AST-0001', 'AST-0002']);
      expect(result.blockers[0]).toContain('AST-0001, AST-0002');
    });

    it('is blocked by a deduction nobody has decided on', async () => {
      flagModel.findAll.mockResolvedValue([flag()]);
      history(3, '2026-10-05T00:00:00Z');

      const result = await service.getClearance(TENANT, AYESHA);

      expect(result.cleared).toBe(false);
      expect(result.pendingDeductions).toEqual([
        expect.objectContaining({ id: FLAG, reason: 'LOST', suggestedAmount: 1899.5, asset: expect.objectContaining({ assetCode: 'AST-0001' }) }),
      ]);
      expect(result.blockers[0]).toContain('waiting for a decision');
    });

    it('waits for IT / Admin to confirm once everything is back', async () => {
      history(2, '2026-10-01T00:00:00Z');

      const result = await service.getClearance(TENANT, AYESHA);

      expect(result).toMatchObject({ cleared: false, readyToConfirm: true, hasAssetHistory: true, confirmation: null });
      expect(result.blockers).toEqual(['IT / Admin has not confirmed the asset clearance yet.']);
    });

    it('is cleared by a confirmation that is newer than anything that happened to their assets', async () => {
      history(2, '2026-10-01T00:00:00Z');
      clearanceModel.findOne.mockResolvedValue({ createdAt: new Date('2026-10-02T00:00:00Z'), confirmedBy: 'it@example.com', note: 'All good' });

      const result = await service.getClearance(TENANT, AYESHA);

      expect(result).toMatchObject({
        cleared: true,
        readyToConfirm: false,
        confirmation: { confirmedBy: 'it@example.com', note: 'All good' },
      });
    });

    it('does not count a confirmation that something has happened since', async () => {
      history(3, '2026-10-05T00:00:00Z');
      clearanceModel.findOne.mockResolvedValue({ createdAt: new Date('2026-10-02T00:00:00Z'), confirmedBy: 'it@example.com' });

      const result = await service.getClearance(TENANT, AYESHA);

      expect(result).toMatchObject({ cleared: false, readyToConfirm: true, confirmation: null });
      expect(result.blockers[0]).toContain('Confirm again');
    });

    it('404s for an employee that is not here', async () => {
      employeeModel.findOne.mockResolvedValue(null);

      await expect(service.getClearance(TENANT, AYESHA)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('confirming the clearance', () => {
    it('records IT / Admin\'s confirmation when nothing is outstanding', async () => {
      history(2, '2026-10-01T00:00:00Z');
      clearanceModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ createdAt: new Date(), confirmedBy: 'it@example.com', note: 'Fine' });

      await service.confirmClearance(admin, AYESHA, { note: 'Fine' });

      expect(clearanceModel.create.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, employeeId: AYESHA, confirmedBy: 'it@example.com', note: 'Fine' });
    });

    it('refuses while assets or deductions are outstanding, saying what', async () => {
      assetModel.findAll.mockResolvedValue([heldAsset()]);
      history(1, '2026-09-01T00:00:00Z');

      await expect(service.confirmClearance(admin, AYESHA, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('AST-0001') });
      expect(clearanceModel.create).not.toHaveBeenCalled();
    });

    it('has nothing to confirm for someone who never had an asset', async () => {
      await expect(service.confirmClearance(admin, AYESHA, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('never had an asset') });
    });

    it('does not record a second confirmation while one is current', async () => {
      history(2, '2026-10-01T00:00:00Z');
      clearanceModel.findOne.mockResolvedValue({ createdAt: new Date('2026-10-02T00:00:00Z'), confirmedBy: 'it@example.com' });

      await service.confirmClearance(admin, AYESHA, {});

      expect(clearanceModel.create).not.toHaveBeenCalled();
    });
  });

  describe('the gate on leaving', () => {
    it('lets someone leave who is cleared, and stops someone who is not', async () => {
      await expect(service.assertCanLeave(TENANT, AYESHA)).resolves.toBeUndefined();

      assetModel.findAll.mockResolvedValue([heldAsset()]);
      history(1, '2026-09-01T00:00:00Z');
      await expect(service.assertCanLeave(TENANT, AYESHA)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('Asset clearance is not complete'),
      });
    });

    it('stops deleting an employee who still has assets, and ignores an empty list', async () => {
      assetModel.count.mockResolvedValue(2);
      await expect(service.assertHoldsNoAssets(TENANT, [AYESHA])).rejects.toMatchObject({ status: 409, message: expect.stringContaining('2 assets') });

      assetModel.count.mockClear();
      await service.assertHoldsNoAssets(TENANT, []);
      expect(assetModel.count).not.toHaveBeenCalled();

      assetModel.count.mockResolvedValue(0);
      await expect(service.assertHoldsNoAssets(TENANT, [AYESHA])).resolves.toBeUndefined();
    });
  });

  describe('deductions', () => {
    it('lists them with how many are waiting', async () => {
      flagModel.findAndCountAll.mockResolvedValue({ rows: [flag()], count: 12 });
      flagModel.count.mockResolvedValue(4);

      const result = await service.getDeductions(TENANT, { status: 'PENDING' as any, employeeId: AYESHA, page: 2, limit: 5 });

      expect(flagModel.findAndCountAll.mock.calls[0][0]).toMatchObject({ limit: 5, offset: 5, where: { tenantId: TENANT, status: 'PENDING', employeeId: AYESHA } });
      expect(result).toMatchObject({ total: 12, totalPages: 3, summary: { pending: 4 } });
      expect(result.data[0]).toMatchObject({ id: FLAG, status: 'PENDING', employee: { name: 'Ayesha Khan' }, suggestedAmount: 1899.5, asset: { purchaseCost: 1899.5 } });
    });

    it('approving writes a one-off deduction for the chosen month that payroll will pick up', async () => {
      const pending = flag();
      flagModel.findOne.mockResolvedValue(pending);

      const result = await service.approveDeduction(admin, FLAG, { amount: 1500, payrollPeriod: '2026-12', note: 'Agreed with employee' });

      expect(adjustmentModel.create.mock.calls[0][0]).toMatchObject({
        tenantId: TENANT,
        payrollRunId: null,
        payrollRecordId: null,
        employeeId: AYESHA,
        payrollPeriod: '2026-12',
        type: PayrollAdjustmentType.DEDUCTION,
        amount: '1500.00',
        reason: 'Asset lost: AST-0001 MacBook',
        createdByEmail: 'it@example.com',
      });
      expect(pending.update.mock.calls[0][0]).toMatchObject({
        status: 'APPROVED',
        amount: '1500.00',
        payrollPeriod: '2026-12',
        payrollAdjustmentId: 'adj-1',
        decisionNote: 'Agreed with employee',
        decidedBy: 'it@example.com',
      });
      expect(result).toMatchObject({ status: 'APPROVED', amount: 1500, payrollPeriod: '2026-12' });
    });

    it('defaults to the current month and says damaged for a damaged asset', async () => {
      flagModel.findOne.mockResolvedValue(flag({ reason: 'DAMAGED' }));

      await service.approveDeduction(admin, FLAG, { amount: 50 });

      const created = adjustmentModel.create.mock.calls[0][0];
      expect(created.payrollPeriod).toBe(new Date().toISOString().slice(0, 7));
      expect(created.reason).toBe('Asset damaged: AST-0001 MacBook');
    });

    it('will not approve into a month payroll has already run', async () => {
      flagModel.findOne.mockResolvedValue(flag());
      runModel.findOne.mockResolvedValue({ id: 'run-1' });

      await expect(service.approveDeduction(admin, FLAG, { amount: 100, payrollPeriod: '2026-10' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('already been run'),
      });
      expect(adjustmentModel.create).not.toHaveBeenCalled();
    });

    it('waiving takes nothing and writes no deduction', async () => {
      const pending = flag();
      flagModel.findOne.mockResolvedValue(pending);

      const result = await service.waiveDeduction(admin, FLAG, { note: 'Normal wear' });

      expect(pending.update.mock.calls[0][0]).toMatchObject({ status: 'WAIVED', decisionNote: 'Normal wear', decidedBy: 'it@example.com' });
      expect(adjustmentModel.create).not.toHaveBeenCalled();
      expect(result.status).toBe('WAIVED');
    });

    it('cannot decide the same deduction twice, and 404s for one that is not here', async () => {
      flagModel.findOne.mockResolvedValue(flag({ status: 'APPROVED' }));
      await expect(service.waiveDeduction(admin, FLAG, {})).rejects.toMatchObject({ status: 409, message: expect.stringContaining('approved') });
      await expect(service.approveDeduction(admin, FLAG, { amount: 10 })).rejects.toMatchObject({ status: 409 });

      flagModel.findOne.mockResolvedValue(null);
      await expect(service.waiveDeduction(admin, FLAG, {})).rejects.toMatchObject({ status: 404 });
    });
  });
});
