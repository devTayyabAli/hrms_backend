import { HttpStatus, Injectable } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  AcceptAssetHandoverDto,
  AssetActorDto,
  AssetRequestStatus,
  AssetStatus,
  TenantErrorCode,
  TenantException,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';

const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');
/** "  Ayesha   KHAN " and "ayesha khan" are the same signature. */
const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const OPEN_REQUEST_STATUSES: string[] = [AssetRequestStatus.OPEN, AssetRequestStatus.IN_PROGRESS];

/**
 * The employee's side of Assets: what they have been given, and signing to say
 * they received it. Read-only apart from the signature — an employee cannot
 * change an asset, only acknowledge it (and ask for repairs, see
 * AssetRequestService).
 *
 * Everything starts from the employee linked to the signed-in login, found the
 * way the rest of the employee portal finds "me", so there is no way to name
 * someone else's assets.
 */
@Injectable()
export class AssetSelfService {
  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  /** The employee behind this login: by login id, then by email. */
  async me(actor: AssetActorDto) {
    const { tenantId, userId, email } = actor;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'firstName', 'lastName'] }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'firstName', 'lastName'] });
    }
    if (!employee) this.fail(HttpStatus.NOT_FOUND, 'No employee profile is linked to this login.');
    return employee;
  }

  /** My Assets: what I have, with what still needs my signature first. */
  async getMyAssets(actor: AssetActorDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Category = await this.modelProvider.getAssetCategoryModel(tenantId);
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);

    const assets = (await Asset.findAll({
      where: { tenantId, assignedEmployeeId: employee.id },
      include: [{ model: Category, as: 'category', attributes: ['id', 'name', 'icon'], required: false }],
      order: [['assignedAt', 'DESC'], ['createdAt', 'DESC']],
    })) as any[];

    const open = assets.length
      ? ((await Request.findAll({
          where: { tenantId, employeeId: employee.id, assetId: { [Op.in]: assets.map((asset) => asset.id) }, status: { [Op.in]: OPEN_REQUEST_STATUSES } },
          attributes: ['assetId'],
        })) as any[])
      : [];
    const openByAsset = new Map<string, number>();
    for (const request of open) openByAsset.set(request.assetId, (openByAsset.get(request.assetId) ?? 0) + 1);

    const rows = assets.map((asset) => ({
      id: asset.id,
      assetCode: asset.assetCode,
      name: asset.name,
      category: asset.category ? { id: asset.category.id, name: asset.category.name, icon: asset.category.icon ?? null } : null,
      brand: asset.brand ?? null,
      serialNumber: asset.serialNumber ?? null,
      specifications: Array.isArray(asset.specifications) ? asset.specifications : [],
      status: asset.status as AssetStatus,
      assignedAt: asset.assignedAt ?? null,
      warrantyExpiry: asset.warrantyExpiry ?? null,
      // Only an asset in use is waiting for a signature: one in repair, or lost, is not something to sign for.
      acceptance: {
        status: asset.acceptedAt ? 'ACCEPTED' : asset.status === AssetStatus.IN_USE ? 'PENDING' : null,
        acceptedAt: asset.acceptedAt ?? null,
        signedName: asset.acceptedSignature ?? null,
      },
      openRequests: openByAsset.get(asset.id) ?? 0,
    }));
    // Waiting for a signature first, then the rest as they were ordered.
    const pending = rows.filter((row) => row.acceptance.status === 'PENDING');

    return {
      data: [...pending, ...rows.filter((row) => row.acceptance.status !== 'PENDING')],
      summary: { total: rows.length, pendingAcceptance: pending.length },
    };
  }

  /**
   * Signs for an asset: "I received it and it works". The signature is the
   * employee's own full name typed out; it has to match their profile. It is
   * kept on the asset and in its history. Something wrong with the asset is not
   * a reason to sign — that is a repair request.
   */
  async acceptHandover(actor: AssetActorDto, assetId: string, dto: AcceptAssetHandoverDto) {
    const { tenantId } = actor;
    const employee = await this.me(actor);
    if (!dto.confirmed) {
      this.fail(HttpStatus.BAD_REQUEST, 'Confirm that you received the asset in working condition. If something is wrong with it, send a repair request instead.');
    }
    if (normalizeName(dto.signature) !== normalizeName(fullName(employee))) {
      this.fail(HttpStatus.BAD_REQUEST, `To sign, type your full name exactly as it is on your profile (${fullName(employee)}).`);
    }

    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Event = await this.modelProvider.getAssetEventModel(tenantId);
    const signedName = dto.signature.trim().replace(/\s+/g, ' ');

    await Asset.sequelize!.transaction(async (transaction) => {
      // Someone else's asset looks the same as one that is not there.
      const asset: any = await Asset.findOne({
        where: { id: assetId, tenantId, assignedEmployeeId: employee.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!asset) this.fail(HttpStatus.NOT_FOUND, `Asset '${assetId}' is not one of your assets.`);
      if (asset.acceptedAt) this.fail(HttpStatus.CONFLICT, 'You have already signed for this asset.');
      if (asset.status !== AssetStatus.IN_USE) {
        this.fail(HttpStatus.CONFLICT, 'This asset is not with you right now, so there is nothing to sign for.');
      }

      const now = new Date();
      await asset.update({ acceptedAt: now, acceptedSignature: signedName }, { transaction });
      await Event.create(
        {
          tenantId,
          assetId,
          type: 'ACCEPTED',
          fromStatus: AssetStatus.IN_USE,
          toStatus: AssetStatus.IN_USE,
          employeeId: employee.id,
          employeeName: fullName(employee),
          details: { signedName, confirmedWorkingOrder: true },
          actorUserId: actor.userId ?? null,
          actorEmail: actor.email ?? null,
        } as any,
        { transaction },
      );
    });

    // The refreshed list, so the screen shows the asset as signed.
    return this.getMyAssets(actor);
  }
}
