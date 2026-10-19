import { Op, UniqueConstraintError } from 'sequelize';
import { AssetStatus, EmployeeStatus } from '@app/common';
import { AssetService, DEFAULT_ASSET_CATEGORIES } from './asset.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ASSET = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const CATEGORY = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const AYESHA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BILAL = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';

const actor = { tenantId: TENANT, userId: 'user-1', email: 'admin@example.com' };

/** A Sequelize-like row whose `update` writes back onto it. */
const row = (values: Record<string, any>) => {
  const r: any = { ...values };
  r.update = jest.fn(async (patch: Record<string, any>) => Object.assign(r, patch));
  r.destroy = jest.fn().mockResolvedValue(undefined);
  return r;
};

const person = (id: string, first: string, last: string, over: Record<string, any> = {}) => ({
  id,
  firstName: first,
  lastName: last,
  employeeCode: 'EMP-1',
  avatarUrl: null,
  status: EmployeeStatus.ACTIVE,
  ...over,
});

describe('AssetService', () => {
  let assetModel: any;
  let categoryModel: any;
  let eventModel: any;
  let employeeModel: any;
  let sequelize: any;
  let people: Record<string, any>;
  let service: AssetService;

  /** The asset the action tests start from. */
  const existing = (over: Record<string, any> = {}) =>
    row({
      id: ASSET,
      tenantId: TENANT,
      assetCode: 'AST-0001',
      name: 'MacBook Pro 14"',
      categoryId: CATEGORY,
      status: AssetStatus.AVAILABLE,
      assignedEmployeeId: null,
      assignedAt: null,
      category: { id: CATEGORY, name: 'Laptop', icon: 'laptop' },
      assignee: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      ...over,
    });

  beforeEach(() => {
    people = { [AYESHA]: person(AYESHA, 'Ayesha', 'Khan'), [BILAL]: person(BILAL, 'Bilal', 'Ahmed') };
    const transaction = { LOCK: { UPDATE: 'UPDATE' } };
    sequelize = {
      query: jest.fn().mockResolvedValue([{ next: 7 }]),
      transaction: jest.fn(async (work: (t: unknown) => unknown) => work(transaction)),
    };
    assetModel = {
      sequelize,
      findOne: jest.fn().mockResolvedValue(null),
      findAndCountAll: jest.fn().mockResolvedValue({ rows: [], count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async (values: any) => existing({ id: ASSET, ...values })),
    };
    categoryModel = {
      sequelize,
      findOne: jest.fn().mockResolvedValue(row({ id: CATEGORY, name: 'Laptop', icon: 'laptop', sortOrder: 0 })),
      findAll: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(5),
      create: jest.fn(async (values: any) => row({ id: 'new-cat', ...values })),
    };
    eventModel = { sequelize, findAll: jest.fn().mockResolvedValue([]), bulkCreate: jest.fn().mockResolvedValue([]) };
    employeeModel = { findOne: jest.fn(async ({ where }: any) => people[where.id] ?? null) };

    const provider: any = {
      getAssetModel: jest.fn().mockResolvedValue(assetModel),
      getAssetCategoryModel: jest.fn().mockResolvedValue(categoryModel),
      getAssetEventModel: jest.fn().mockResolvedValue(eventModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
    };
    service = new AssetService(provider);
  });

  /** What the next read of the asset (after an action) returns, plus the history. */
  const afterAction = (asset: any) => {
    assetModel.findOne.mockImplementation(async () => asset);
  };

  const recorded = () => eventModel.bulkCreate.mock.calls.flatMap((call: any[]) => call[0]) as any[];

  describe('categories', () => {
    it('gives a new organization the starter categories on first visit', async () => {
      categoryModel.count.mockResolvedValue(0);
      categoryModel.findAll.mockResolvedValue([]);
      assetModel.sequelize.query.mockResolvedValue([]);

      await service.getCategories(TENANT);

      expect(categoryModel.create).toHaveBeenCalledTimes(DEFAULT_ASSET_CATEGORIES.length);
      expect(categoryModel.create.mock.calls.map((c: any[]) => c[0].name)).toEqual(['Laptop', 'Monitor', 'Mobile Phone', 'Furniture', 'IT Equipment']);
    });

    it('does not seed an organization that already has categories', async () => {
      await service.getCategories(TENANT);
      expect(categoryModel.create).not.toHaveBeenCalled();
    });

    it('lists categories with how many assets each holds', async () => {
      categoryModel.findAll.mockResolvedValue([row({ id: CATEGORY, name: 'Laptop', icon: 'laptop' }), row({ id: 'c2', name: 'Monitor', icon: null })]);
      sequelize.query.mockResolvedValue([{ categoryId: CATEGORY, count: 18 }]);

      const result = await service.getCategories(TENANT);

      expect(result.data).toEqual([
        { id: CATEGORY, name: 'Laptop', icon: 'laptop', assetCount: 18 },
        { id: 'c2', name: 'Monitor', icon: null, assetCount: 0 },
      ]);
    });

    it('refuses a duplicate category name, ignoring case', async () => {
      categoryModel.findOne.mockResolvedValueOnce(row({ id: 'other' }));

      await expect(service.createCategory(actor, { name: ' laptop ' })).rejects.toMatchObject({ status: 409 });
      expect(categoryModel.create).not.toHaveBeenCalled();
    });

    it('will not delete a category that assets use, and says how many', async () => {
      assetModel.count.mockResolvedValue(3);

      await expect(service.deleteCategory(actor, CATEGORY)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('3 assets') });
    });

    it('deletes an unused category', async () => {
      const category = row({ id: CATEGORY, name: 'Laptop' });
      categoryModel.findOne.mockResolvedValue(category);

      await expect(service.deleteCategory(actor, CATEGORY)).resolves.toEqual({ deleted: true, id: CATEGORY });
      expect(category.destroy).toHaveBeenCalled();
    });
  });

  describe('the asset table', () => {
    it('pages and maps rows, with the holder and category', async () => {
      assetModel.findAndCountAll.mockResolvedValue({
        count: 26,
        rows: [existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA, assignee: person(AYESHA, 'Ayesha', 'Khan'), purchaseCost: '1899.50', serialNumber: 'SN1' })],
      });

      const result = await service.getAssets(TENANT, { page: 2, limit: 8 });

      expect(assetModel.findAndCountAll.mock.calls[0][0]).toMatchObject({ limit: 8, offset: 8 });
      expect(result).toMatchObject({ total: 26, page: 2, limit: 8, totalPages: 4 });
      expect(result.data[0]).toMatchObject({
        assetCode: 'AST-0001',
        category: { name: 'Laptop' },
        assignedTo: { employeeId: AYESHA, name: 'Ayesha Khan' },
        purchaseCost: 1899.5,
        serialNumber: 'SN1',
      });
    });

    it('filters by status, category and holder, and searches the holder\'s name too', async () => {
      await service.getAssets(TENANT, { status: 'IN_USE' as any, categoryId: CATEGORY, assignedEmployeeId: AYESHA, search: 'ayesha' });

      const where = assetModel.findAndCountAll.mock.calls[0][0].where;
      expect(where).toMatchObject({ tenantId: TENANT, status: 'IN_USE', categoryId: CATEGORY, assignedEmployeeId: AYESHA });
      const searched = where[Op.or].map((clause: any) => Object.keys(clause)[0]);
      expect(searched).toEqual(expect.arrayContaining(['name', 'assetCode', 'serialNumber', '$assignee.firstName$', '$assignee.lastName$']));
    });

    it('does not filter by status for ALL, and escapes LIKE wildcards in the search', async () => {
      await service.getAssets(TENANT, { status: 'ALL' as any, search: '50%_off' });

      const where = assetModel.findAndCountAll.mock.calls[0][0].where;
      expect(where.status).toBeUndefined();
      expect(where[Op.or][0].name[Op.iLike]).toBe('%50\\%\\_off%');
    });

    it('caps the export and reports truncation', async () => {
      assetModel.findAndCountAll.mockResolvedValue({ count: 12000, rows: Array.from({ length: 10000 }, () => existing()) });

      const result = await service.exportAssets(TENANT, {});

      expect(result).toMatchObject({ totalMatched: 12000, truncated: true, limit: 10000 });
      expect(result.rows).toHaveLength(10000);
    });
  });

  describe('summary', () => {
    const counts = (rows: Record<string, number>) => Object.entries(rows).map(([status, count]) => ({ status, count }));

    it('gives the cards with change since the start of the month, the donut and the categories', async () => {
      sequelize.query
        .mockResolvedValueOnce(counts({ IN_USE: 48, MAINTENANCE: 5, DISPOSED: 3 })) // now
        .mockResolvedValueOnce(counts({ IN_USE: 40, MAINTENANCE: 5, DISPOSED: 2, AVAILABLE: 1 })) // start of month
        .mockResolvedValueOnce([{ categoryId: CATEGORY, count: 56 }]); // categories
      categoryModel.findAll.mockResolvedValue([row({ id: CATEGORY, name: 'Laptop', icon: 'laptop' })]);

      const result = await service.getSummary(TENANT);

      expect(result.stats.total).toEqual({ value: 56, previous: 48, changePercent: 16.7 });
      expect(result.stats.inUse).toEqual({ value: 48, previous: 40, changePercent: 20 });
      expect(result.stats.maintenance.changePercent).toBe(0);
      expect(result.stats.disposed.changePercent).toBe(50);
      expect(result.total).toBe(56);
      expect(result.statusBreakdown).toEqual([
        { status: 'IN_USE', count: 48, percent: 85.7 },
        { status: 'MAINTENANCE', count: 5, percent: 8.9 },
        { status: 'DISPOSED', count: 3, percent: 5.4 },
        { status: 'AVAILABLE', count: 0, percent: 0 },
      ]);
      expect(result.categories[0]).toMatchObject({ name: 'Laptop', assetCount: 56 });
    });

    it('has no percentage when there was nothing to compare with, and no divide-by-zero on an empty register', async () => {
      sequelize.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await service.getSummary(TENANT);

      expect(result.stats.total).toEqual({ value: 0, previous: 0, changePercent: null });
      expect(result.statusBreakdown.every((slice) => slice.percent === 0)).toBe(true);
    });

    it('compares against the first of this month, in UTC', async () => {
      sequelize.query.mockResolvedValue([]);

      const result = await service.getSummary(TENANT);

      const moment = sequelize.query.mock.calls[1][1].replacements.moment as Date;
      expect(moment.getUTCDate()).toBe(1);
      expect(moment.getUTCHours()).toBe(0);
      expect(result.comparedWith).toBe(moment.toISOString());
    });
  });

  describe('adding an asset', () => {
    beforeEach(() => {
      assetModel.findOne.mockResolvedValue(null); // no serial clash; also the post-create reload is stubbed below
    });

    it('numbers it from the highest code, starts it Available and records that it was added', async () => {
      const created = existing({ id: ASSET, assetCode: 'AST-0007' });
      assetModel.findOne.mockResolvedValueOnce(null).mockResolvedValue(created);

      const result = await service.createAsset(actor, { name: ' Dell Monitor 27" ', categoryId: CATEGORY, serialNumber: 'SN9' });

      const values = assetModel.create.mock.calls[0][0];
      expect(values).toMatchObject({ assetCode: 'AST-0007', name: 'Dell Monitor 27"', status: 'AVAILABLE', assignedEmployeeId: null, createdBy: 'user-1' });
      expect(recorded().map((event) => event.type)).toEqual(['CREATED']);
      expect(result.assetCode).toBe('AST-0007');
    });

    it('can give it to an employee at once: In Use, with both events', async () => {
      assetModel.findOne.mockResolvedValue(existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA }));

      await service.createAsset(actor, { name: 'Phone', categoryId: CATEGORY, assignedEmployeeId: AYESHA });

      expect(assetModel.create.mock.calls[0][0]).toMatchObject({ status: 'IN_USE', assignedEmployeeId: AYESHA });
      expect(recorded().map((event) => event.type)).toEqual(['CREATED', 'ASSIGNED']);
      expect(recorded()[1]).toMatchObject({ toStatus: 'IN_USE', employeeId: AYESHA, employeeName: 'Ayesha Khan' });
    });

    it('refuses a category from nowhere, a taken serial number, and someone who left', async () => {
      categoryModel.findOne.mockResolvedValueOnce(null);
      await expect(service.createAsset(actor, { name: 'x', categoryId: CATEGORY })).rejects.toMatchObject({ status: 400 });

      assetModel.findOne.mockResolvedValueOnce({ id: 'other', assetCode: 'AST-0003' });
      await expect(service.createAsset(actor, { name: 'x', categoryId: CATEGORY, serialNumber: 'SN1' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('AST-0003'),
      });

      people[BILAL].status = EmployeeStatus.RESIGNED;
      await expect(service.createAsset(actor, { name: 'x', categoryId: CATEGORY, assignedEmployeeId: BILAL })).rejects.toMatchObject({ status: 409 });
      expect(assetModel.create).not.toHaveBeenCalled();
    });

    it('takes the next code when two people add an asset at the same moment', async () => {
      assetModel.findOne.mockResolvedValue(existing());
      assetModel.create
        .mockRejectedValueOnce(Object.assign(new UniqueConstraintError({ errors: [] } as any), { fields: { assetCode: 'AST-0007' } }))
        .mockImplementation(async (values: any) => existing(values));

      await service.createAsset(actor, { name: 'x', categoryId: CATEGORY });

      expect(assetModel.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('editing', () => {
    it('changes details but never status or holder', async () => {
      const asset = existing();
      afterAction(asset);

      await service.updateAsset(actor, ASSET, { name: ' New name ', notes: null, location: 'HQ' });

      expect(asset.update).toHaveBeenCalledWith({ name: 'New name', notes: null, location: 'HQ' });
    });

    it('refuses to edit a disposed asset', async () => {
      afterAction(existing({ status: AssetStatus.DISPOSED }));

      await expect(service.updateAsset(actor, ASSET, { name: 'x' })).rejects.toMatchObject({ status: 409 });
    });

    it('404s for an asset that is not here', async () => {
      await expect(service.updateAsset(actor, ASSET, { name: 'x' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('deleting', () => {
    it('will not delete an asset someone still has', async () => {
      afterAction(existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA }));

      await expect(service.deleteAsset(actor, ASSET)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Return it') });
    });

    it('deletes an asset nobody has', async () => {
      const asset = existing();
      afterAction(asset);

      await expect(service.deleteAsset(actor, ASSET)).resolves.toEqual({ deleted: true, id: ASSET });
      expect(asset.destroy).toHaveBeenCalled();
    });
  });

  describe('assigning', () => {
    it('gives an available asset to an employee and records it', async () => {
      const asset = existing();
      afterAction(asset);

      await service.assign(actor, ASSET, { employeeId: AYESHA, note: 'Onboarding' });

      expect(asset.update.mock.calls[0][0]).toMatchObject({ status: 'IN_USE', assignedEmployeeId: AYESHA });
      expect(recorded()).toEqual([
        expect.objectContaining({ type: 'ASSIGNED', fromStatus: 'AVAILABLE', toStatus: 'IN_USE', employeeId: AYESHA, employeeName: 'Ayesha Khan', note: 'Onboarding', actorEmail: 'admin@example.com' }),
      ]);
    });

    it('takes it from the previous holder first, recording both', async () => {
      const asset = existing({ status: AssetStatus.IN_USE, assignedEmployeeId: BILAL });
      afterAction(asset);

      await service.assign(actor, ASSET, { employeeId: AYESHA });

      expect(recorded().map((event) => [event.type, event.employeeName])).toEqual([
        ['RETURNED', 'Bilal Ahmed'],
        ['ASSIGNED', 'Ayesha Khan'],
      ]);
      expect(asset.update.mock.calls[0][0]).toMatchObject({ assignedEmployeeId: AYESHA });
    });

    it.each([
      [AssetStatus.DISPOSED, 'disposed'],
      [AssetStatus.MAINTENANCE, 'maintenance'],
    ])('will not assign a %s asset', async (status, word) => {
      afterAction(existing({ status }));

      await expect(service.assign(actor, ASSET, { employeeId: AYESHA })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(word) });
      expect(eventModel.bulkCreate).not.toHaveBeenCalled();
    });

    it('will not give it to the person who already has it, or to someone who left', async () => {
      afterAction(existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA }));
      await expect(service.assign(actor, ASSET, { employeeId: AYESHA })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already has') });

      people[BILAL].status = EmployeeStatus.RESIGNED;
      await expect(service.assign(actor, ASSET, { employeeId: BILAL })).rejects.toMatchObject({ status: 409 });
    });

    it('400s for an employee that does not exist', async () => {
      await expect(service.assign(actor, ASSET, { employeeId: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0' })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('returning', () => {
    it('puts it back in stock and keeps the holder in the history', async () => {
      const asset = existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA });
      afterAction(asset);

      await service.returnAsset(actor, ASSET, 'Left the company');

      expect(asset.update.mock.calls[0][0]).toEqual({ status: 'AVAILABLE', assignedEmployeeId: null, assignedAt: null });
      expect(recorded()[0]).toMatchObject({ type: 'RETURNED', toStatus: 'AVAILABLE', employeeId: AYESHA, employeeName: 'Ayesha Khan', note: 'Left the company' });
    });

    it('only works on an asset that is in use', async () => {
      afterAction(existing());

      await expect(service.returnAsset(actor, ASSET)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('maintenance', () => {
    it('sends an assigned asset for maintenance without losing its holder', async () => {
      const asset = existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA });
      afterAction(asset);

      await service.startMaintenance(actor, ASSET, 'Screen flickering');

      expect(asset.update.mock.calls[0][0]).toEqual({ status: 'MAINTENANCE' });
      expect(recorded()[0]).toMatchObject({ type: 'MAINTENANCE_STARTED', fromStatus: 'IN_USE', toStatus: 'MAINTENANCE', employeeId: AYESHA });
    });

    it('will not start twice, or on a disposed asset', async () => {
      afterAction(existing({ status: AssetStatus.MAINTENANCE }));
      await expect(service.startMaintenance(actor, ASSET)).rejects.toMatchObject({ status: 409 });

      afterAction(existing({ status: AssetStatus.DISPOSED }));
      await expect(service.startMaintenance(actor, ASSET)).rejects.toMatchObject({ status: 409 });
    });

    it('finishing puts it back in use for its holder, or in stock if it has none', async () => {
      const held = existing({ status: AssetStatus.MAINTENANCE, assignedEmployeeId: AYESHA });
      afterAction(held);
      await service.completeMaintenance(actor, ASSET);
      expect(held.update.mock.calls[0][0]).toEqual({ status: 'IN_USE' });

      const loose = existing({ status: AssetStatus.MAINTENANCE });
      afterAction(loose);
      await service.completeMaintenance(actor, ASSET);
      expect(loose.update.mock.calls[0][0]).toEqual({ status: 'AVAILABLE' });
    });

    it('can only be finished when it is under maintenance', async () => {
      afterAction(existing());

      await expect(service.completeMaintenance(actor, ASSET)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('disposing', () => {
    it('writes it off: nobody has it, with the reason and the former holder in the history', async () => {
      const asset = existing({ status: AssetStatus.IN_USE, assignedEmployeeId: AYESHA });
      afterAction(asset);

      await service.dispose(actor, ASSET, { reason: 'Beyond repair' });

      expect(asset.update.mock.calls[0][0]).toMatchObject({ status: 'DISPOSED', assignedEmployeeId: null, assignedAt: null, disposalReason: 'Beyond repair' });
      expect(asset.update.mock.calls[0][0].disposedAt).toBeInstanceOf(Date);
      expect(recorded()[0]).toMatchObject({ type: 'DISPOSED', fromStatus: 'IN_USE', toStatus: 'DISPOSED', employeeId: AYESHA, note: 'Beyond repair' });
    });

    it('cannot be done twice', async () => {
      afterAction(existing({ status: AssetStatus.DISPOSED }));

      await expect(service.dispose(actor, ASSET, {})).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('one asset', () => {
    it('returns the asset with its history, newest first, naming who did what', async () => {
      afterAction(existing());
      eventModel.findAll.mockResolvedValue([
        row({ id: 'ev2', type: 'ASSIGNED', fromStatus: 'AVAILABLE', toStatus: 'IN_USE', employeeId: AYESHA, employeeName: 'Ayesha Khan', note: null, actorEmail: 'admin@example.com', createdAt: new Date('2026-10-02T00:00:00Z') }),
        row({ id: 'ev1', type: 'CREATED', fromStatus: null, toStatus: 'AVAILABLE', employeeId: null, employeeName: null, note: null, actorEmail: null, createdAt: new Date('2026-10-01T00:00:00Z') }),
      ]);

      const result = await service.getAsset(TENANT, ASSET);

      expect(eventModel.findAll.mock.calls[0][0].order).toEqual([['createdAt', 'DESC'], ['id', 'ASC']]);
      expect(result.history).toEqual([
        expect.objectContaining({ type: 'ASSIGNED', employee: { employeeId: AYESHA, name: 'Ayesha Khan' }, by: 'admin@example.com' }),
        expect.objectContaining({ type: 'CREATED', employee: null, by: null }),
      ]);
    });

    it('404s for an asset that is not in this organization', async () => {
      await expect(service.getAsset(TENANT, ASSET)).rejects.toMatchObject({ status: 404 });
    });
  });
});
