import { Injectable } from '@nestjs/common';
import { Model, Sequelize } from 'sequelize-typescript';
import {
  BaseTenantModelProvider,
  TenantConnectionManager,
  TenantContextService,
} from '@app/tenant-context';
import { ProjectionOutbox } from '@app/database';
import {
  User,
  Role,
  Permission,
  UserRole,
  RolePermission,
  EntityAuditLog,
} from '../models';

/** Field values never written to the audit trail in plaintext. */
const REDACTED_FIELDS = new Set(['passwordHash', 'password']);

/** Models that get an entity_audit_logs row on create/update/delete. */
const AUDITED_MODEL_NAMES = new Set([
  'User',
  'Role',
  'Permission',
  'UserRole',
  'RolePermission',
]);

/**
 * Resolves per-tenant Sequelize connections for user-service's access-control
 * models, and attaches this service's change-history hooks to each one.
 *
 * Connection resolution, caching and schema-sync gating live in
 * BaseTenantModelProvider, shared with tenant-service's provider. What is
 * specific here is the model list and the audit hooks.
 *
 * MUST stay singleton-scoped — see BaseTenantModelProvider for why. It
 * matters doubly here: `addHook` appends, so a second instance preparing the
 * same connection would write two audit rows per change.
 */
@Injectable()
export class TenantModelProviderService extends BaseTenantModelProvider {
  constructor(
    tenantContextService: TenantContextService,
    connectionManager: TenantConnectionManager,
  ) {
    super(
      tenantContextService,
      connectionManager,
      TenantModelProviderService.name,
    );
  }

  protected get models(): Array<typeof Model> {
    return [
      User,
      Role,
      Permission,
      UserRole,
      RolePermission,
      EntityAuditLog,
      // The SuperAdmin directory's transactional outbox. Bound here so a user
      // write and its projection event share one transaction.
      ProjectionOutbox,
    ] as unknown as Array<typeof Model>;
  }

  getProjectionOutboxModel(tenantId?: string): Promise<typeof ProjectionOutbox> {
    return this.model<typeof ProjectionOutbox>('ProjectionOutbox', tenantId);
  }

  protected onConnectionPrepared(connection: Sequelize): void {
    this.registerAuditHooks(connection);
  }

  /**
   * Registers connection-wide (not per-model) hooks so every access-control
   * model on this tenant's database gets an entity_audit_logs row on
   * create/update/delete — no @BeforeUpdate()/@BeforeDestroy() decorator
   * duplicated across every model file.
   *
   * The base class calls this exactly once per connection *instance*, which
   * is what keeps hooks from stacking up: `addHook` appends, so registering
   * twice on one connection would write two audit rows per change, three
   * times three, and so on.
   */
  private registerAuditHooks(connection: Sequelize): void {
    const record =
      (action: 'CREATE' | 'UPDATE' | 'DELETE') =>
      async (instance: any): Promise<void> => {
        const modelName = instance?.constructor?.name;
        if (!modelName || !AUDITED_MODEL_NAMES.has(modelName)) {
          return;
        }

        const changes: Record<string, { from: unknown; to: unknown }> = {};

        if (action === 'UPDATE') {
          const changedFields: string[] =
            typeof instance.changed === 'function'
              ? instance.changed() || []
              : [];
          for (const field of changedFields) {
            changes[field] = REDACTED_FIELDS.has(field)
              ? { from: '[redacted]', to: '[redacted]' }
              : {
                  from:
                    typeof instance.previous === 'function'
                      ? instance.previous(field)
                      : undefined,
                  to: instance.get(field),
                };
          }
        } else if (action === 'CREATE') {
          const plain = instance.get({ plain: true });
          for (const [field, value] of Object.entries(plain)) {
            changes[field] = REDACTED_FIELDS.has(field)
              ? { from: null, to: '[redacted]' }
              : { from: null, to: value };
          }
        }
        // DELETE: no field-level diff, just the fact of deletion (table + recordId) below.

        try {
          const AuditLogModel = connection.models.EntityAuditLog;
          await AuditLogModel.create({
            tableName: modelName,
            recordId: String(instance.id),
            action,
            userId: this.tenantContextService.getContext()?.userId || null,
            changes: Object.keys(changes).length > 0 ? changes : null,
          });
        } catch (err: any) {
          // Never let audit-logging failure roll back or mask the underlying
          // business operation — the row was already created/updated/destroyed.
          this.logger.error(
            `Failed to write audit log for ${modelName}: ${err.message}`,
          );
        }
      };

    connection.addHook('afterCreate', record('CREATE'));
    connection.addHook('afterUpdate', record('UPDATE'));
    connection.addHook('afterDestroy', record('DELETE'));
  }

  getUserModel(tenantId?: string): Promise<typeof User> {
    return this.model<typeof User>('User', tenantId);
  }

  getRoleModel(tenantId?: string): Promise<typeof Role> {
    return this.model<typeof Role>('Role', tenantId);
  }

  getPermissionModel(tenantId?: string): Promise<typeof Permission> {
    return this.model<typeof Permission>('Permission', tenantId);
  }

  getUserRoleModel(tenantId?: string): Promise<typeof UserRole> {
    return this.model<typeof UserRole>('UserRole', tenantId);
  }

  getRolePermissionModel(tenantId?: string): Promise<typeof RolePermission> {
    return this.model<typeof RolePermission>('RolePermission', tenantId);
  }

  /**
   * Query this tenant's change-history trail (see registerAuditHooks).
   */
  async queryEntityAuditLogs(
    tenantId: string,
    filter: {
      tableName?: string;
      recordId?: string;
      action?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<{
    total: number;
    page: number;
    limit: number;
    items: EntityAuditLog[];
  }> {
    const connection = await this.getConnection(tenantId);
    const AuditLogModel = connection.models.EntityAuditLog;

    const where: Record<string, unknown> = {};
    if (filter.tableName) where.tableName = filter.tableName;
    if (filter.recordId) where.recordId = filter.recordId;
    if (filter.action) where.action = filter.action;

    const page = filter.page && filter.page > 0 ? filter.page : 1;
    const limit =
      filter.limit && filter.limit > 0 ? Math.min(filter.limit, 100) : 25;

    const { rows, count } = await AuditLogModel.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { total: count, page, limit, items: rows as EntityAuditLog[] };
  }
}
