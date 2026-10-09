import type { Sequelize } from 'sequelize-typescript';

export interface AddMissingColumnsResult {
  added: string[];
  /** Added nullable although the model says NOT NULL with no default — backfill, then tighten by hand. */
  relaxed: string[];
}

/**
 * Additive schema reconciliation: adds every column a registered model
 * declares that its existing table lacks.
 *
 * `sync()` creates missing tables but never touches an existing one, so a
 * column added to a model after its table was first created never reached
 * the database and surfaced as `column "<name>" does not exist` at runtime.
 *
 * Deliberately additive only — never drops, renames or retypes — so it is
 * safe to run on every start against a database holding real rows. A
 * NOT NULL column with no default is added as nullable, since adding it as
 * NOT NULL would fail on the existing rows.
 */
export async function addMissingColumns(
  sequelize: Sequelize,
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): Promise<AddMissingColumnsResult> {
  const log = options.log ?? (() => undefined);
  const queryInterface = sequelize.getQueryInterface();
  const [rows]: any = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  );

  const existing = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!existing.has(row.table_name)) existing.set(row.table_name, new Set());
    existing.get(row.table_name)!.add(row.column_name);
  }

  const result: AddMissingColumnsResult = { added: [], relaxed: [] };
  for (const model of Object.values(sequelize.models) as any[]) {
    const tableName = model.getTableName() as string;
    const columns = existing.get(tableName);
    // A table that doesn't exist yet is sync()'s job.
    if (!columns) continue;

    const attributes = model.getAttributes();
    for (const attributeName of Object.keys(attributes)) {
      const attribute = attributes[attributeName];
      const field: string = attribute.field || attributeName;
      if (columns.has(field)) continue;

      const hasDefault = attribute.defaultValue !== undefined;
      const enforceNotNull = attribute.allowNull === false && hasDefault;
      const definition = { ...attribute, allowNull: !enforceNotNull };
      delete definition.field;
      // Primary keys and references belong to table creation, not to an added column.
      delete definition.primaryKey;
      delete definition.references;

      const name = `${tableName}.${field}`;
      if (attribute.allowNull === false && !enforceNotNull) result.relaxed.push(name);
      log(`${options.dryRun ? 'Would add' : 'Adding'} column ${name}`);
      if (!options.dryRun) await queryInterface.addColumn(tableName, field, definition);
      columns.add(field);
      result.added.push(name);
    }
  }
  return result;
}
