import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Op } from 'sequelize';
import { firstValueFrom, timeout } from 'rxjs';
import { EmployeeNotificationKind, MESSAGE_PATTERNS, SERVICES } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import type { Approval } from './approval-engine';

const RPC_TIMEOUT_MS = 8000;
/** A permission held by a very large group is not an inbox flood: the first people are told. */
const MAX_RECIPIENTS = 50;

/**
 * Tells the people a request is waiting on when its current stage is a
 * permission rather than a named person: everyone who holds that permission
 * (and the Organization Admins) gets a line in their notifications.
 *
 * Best effort and quiet on failure — the request is already saved, and a
 * notification that cannot be sent must not undo it.
 */
@Injectable()
export class PermissionHoldersService {
  private readonly logger = new Logger(PermissionHoldersService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    @Inject(SERVICES.USER_SERVICE) private readonly userClient: ClientProxy,
  ) {}

  /** The employees whose login holds `permission`. People with a login but no employee record are not reachable here. */
  async employeeIdsHolding(tenantId: string, permission: string): Promise<string[]> {
    const holders: { id: string; email?: string }[] =
      (await firstValueFrom(this.userClient.send(MESSAGE_PATTERNS.ROLE.PERMISSION_HOLDERS, { tenantId, permission }).pipe(timeout(RPC_TIMEOUT_MS)))) ?? [];
    if (!holders.length) return [];
    const userIds = holders.map((holder) => holder.id).filter(Boolean);
    const emails = holders.map((holder) => holder.email).filter((email): email is string => Boolean(email));
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const rows = (await Employee.findAll({
      where: {
        tenantId,
        [Op.or]: [...(userIds.length ? [{ userId: { [Op.in]: userIds } }] : []), ...emails.map((email) => ({ email: { [Op.iLike]: email } }))],
      },
      attributes: ['id'],
      raw: true,
    })) as unknown as { id: string }[];
    return [...new Set(rows.map((row) => row.id))];
  }

  /**
   * Notifies the holders of the permission the request is now waiting on.
   * Does nothing when a named person (or HR) is the current stage.
   */
  async tell(tenantId: string, approval: Approval | null | undefined, exceptEmployeeIds: string[], title: string, body: string): Promise<void> {
    if (!approval || approval.currentApproverId || !approval.currentPermission) return;
    await this.tellPermission(tenantId, approval.currentPermission, exceptEmployeeIds, title, body);
  }

  /** Notifies everyone who holds `permission`, except the people named. */
  async tellPermission(tenantId: string, permission: string, exceptEmployeeIds: string[], title: string, body: string): Promise<void> {
    try {
      const skip = new Set(exceptEmployeeIds);
      const recipients = (await this.employeeIdsHolding(tenantId, permission)).filter((id) => !skip.has(id)).slice(0, MAX_RECIPIENTS);
      if (!recipients.length) return;
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      for (const employeeId of recipients) {
        await Notification.create({ tenantId, employeeId, kind: EmployeeNotificationKind.REQUEST, title, body, readAt: null } as any);
      }
    } catch (error: any) {
      this.logger.warn(`The people holding ${permission} were not told about "${title}": ${error?.message ?? error}`);
    }
  }
}
