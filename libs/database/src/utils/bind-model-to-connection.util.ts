import { Model, Sequelize } from 'sequelize-typescript';

/**
 * Registers `modelClass` on `connection` as an independent, connection-bound
 * subclass instead of mutating the shared decorated class in place.
 *
 * `Sequelize#addModels()` (sequelize-typescript) calls `Model.init()`
 * directly on whatever class it is given, which sets that class's *static*
 * `sequelize` property. When the same decorated model classes (e.g.
 * `Department`, `User`) are registered on more than one Sequelize connection
 * in the same process — exactly what every per-tenant physical database
 * requires — each new `addModels()` call silently repoints the shared
 * class's `.sequelize` at the newest connection, which also hijacks every
 * previously cached `connection.models.X` reference for that same class
 * (they're the identical object, not a copy). A handle resolved for Tenant A
 * would then silently start querying Tenant B's database the moment Tenant
 * B's connection is opened in the same process.
 *
 * Binding a small per-connection subclass (`class extends modelClass {}`)
 * avoids this: sequelize-typescript resolves associations
 * (`@BelongsTo`/`@HasMany`/...) by model *name* within the target
 * connection's own registry, not by class identity, so associations declared
 * on the original decorated class continue to resolve correctly against the
 * bound subclass.
 */
export function bindModelToConnection<T extends typeof Model>(
  modelClass: T,
  connection: Sequelize,
): T {
  bindModelsToConnection([modelClass], connection);
  return connection.models[modelClass.name] as unknown as T;
}

/**
 * Binds each of `modelClasses` to `connection`; see {@link bindModelToConnection}.
 *
 * All subclasses are handed to a *single* `addModels()` call on purpose.
 * `addModels()` defines every model it is given and only then resolves their
 * associations, so registering the list one model at a time would resolve
 * each model's associations against a registry that does not yet contain the
 * models later in the list — a `@BelongsToMany(() => Role, () => UserRole)`
 * on the first class would fail with "UserRole has not been defined". Passing
 * the whole set at once means every association target and `through` model is
 * already defined on this connection by the time it is looked up by name.
 */
export function bindModelsToConnection(
  modelClasses: Array<typeof Model>,
  connection: Sequelize,
): void {
  const bound = modelClasses.map((modelClass) => {
    // Named via a computed object key so the subclass keeps the original
    // class name — sequelize-typescript resolves associations by model name.
    const subclass = {
      [modelClass.name]: class extends (modelClass as any) {},
    }[modelClass.name];
    return subclass as unknown as typeof Model;
  });
  connection.addModels(bound as any);
}
