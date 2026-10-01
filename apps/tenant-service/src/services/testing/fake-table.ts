import { Op } from 'sequelize';

/**
 * A small in-memory stand-in for a Sequelize model, for service specs. It
 * understands only the query shapes the payroll services use — equality,
 * null, Op.in / ne / lt / lte / gt / gte / between / iLike (with Op.any), Op.and /
 * Op.or — and ignores `include`, so fixtures attach associations directly.
 */

let seq = 0;
export const fakeUuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Does a stored row satisfy a Sequelize `where`? */
export const matches = (row: any, where: any = {}): boolean =>
  Reflect.ownKeys(where).every((key) => {
    const condition = where[key as any];
    if (key === Op.and) return (condition as any[]).every((part) => matches(row, part));
    if (key === Op.or) return (condition as any[]).some((part) => matches(row, part));
    const value = row[key as string];
    if (condition === null) return value === null || value === undefined;
    if (typeof condition !== 'object' || condition instanceof Date) return value === condition;
    return Reflect.ownKeys(condition).every((op) => {
      const operand = condition[op as any];
      if (op === Op.in) return (operand as any[]).includes(value);
      if (op === Op.ne) return value !== operand;
      if (op === Op.lte) return value !== null && value !== undefined && value <= operand;
      if (op === Op.gte) return value !== null && value !== undefined && value >= operand;
      if (op === Op.lt) return value !== null && value !== undefined && value < operand;
      if (op === Op.gt) return value !== null && value !== undefined && value > operand;
      if (op === Op.between) return value >= operand[0] && value <= operand[1];
      if (op === Op.iLike) {
        const candidates = operand[Op.any as any] ?? [operand];
        return candidates.some((c: string) => String(value).toLowerCase() === String(c).toLowerCase());
      }
      return true;
    });
  });

/** A table: rows are plain objects with update()/destroy() like Sequelize instances. */
export const table = (rows: any[] = []) => {
  const store: any[] = [];
  const wrap = (values: any) => {
    const row: any = { id: fakeUuid(), createdAt: new Date(), updatedAt: new Date(), ...values };
    row.update = jest.fn(async (patch: any) => Object.assign(row, patch, { updatedAt: new Date() }));
    row.destroy = jest.fn(async () => store.splice(store.indexOf(row), 1));
    store.push(row);
    return row;
  };
  rows.forEach(wrap);
  const sorted = (found: any[], order?: any[]) => {
    if (!order?.length) return found;
    const [field, direction] = order[0];
    return [...found].sort((a, b) => (a[field] > b[field] ? 1 : -1) * (direction === 'DESC' ? -1 : 1));
  };
  const model: any = {
    rows: store,
    findOne: jest.fn(async (options: any = {}) => sorted(store.filter((r) => matches(r, options.where)), options.order)[0] ?? null),
    findAll: jest.fn(async (options: any = {}) => sorted(store.filter((r) => matches(r, options.where)), options.order)),
    findByPk: jest.fn(async (id: string) => store.find((r) => r.id === id) ?? null),
    count: jest.fn(async (options: any = {}) => store.filter((r) => matches(r, options.where)).length),
    max: jest.fn(async (field: string) => (store.length ? Math.max(...store.map((r) => Number(r[field]) || 0)) : null)),
    create: jest.fn(async (values: any) => wrap(values)),
    bulkCreate: jest.fn(async (values: any[]) => values.map(wrap)),
    update: jest.fn(async (patch: any, options: any = {}) => {
      const hit = store.filter((r) => matches(r, options.where));
      hit.forEach((r) => Object.assign(r, patch, { updatedAt: new Date() }));
      return [hit.length];
    }),
    destroy: jest.fn(async (options: any = {}) => {
      const gone = store.filter((r) => matches(r, options.where));
      gone.forEach((r) => store.splice(store.indexOf(r), 1));
      return gone.length;
    }),
    sequelize: { transaction: async (work: (t: unknown) => unknown) => work({}) },
  };
  return model;
};
