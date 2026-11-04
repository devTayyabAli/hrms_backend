import { HttpStatus, Injectable } from '@nestjs/common';
import { Op, QueryTypes } from 'sequelize';
import {
  AssetActorDto,
  AssetRequestDecision,
  AssetRequestStatus,
  AssetStatus,
  CreateAssetRequestDto,
  GetAssetRequestsQueryDto,
  TenantErrorCode,
  TenantException,
  UpdateAssetRequestDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { AssetSelfService } from './asset-self.service';

const OPEN_STATUSES: string[] = [AssetRequestStatus.OPEN, AssetRequestStatus.IN_PROGRESS];
const ESCAPE = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
const fullName = (employee: any) => [employee?.firstName, employee?.lastName].filter(Boolean).join(' ');
const MY_REQUESTS_LIMIT = 50;

/** What a request is allowed to move to. A decided request (resolved or rejected) is final. */
const TRANSITIONS: Record<string, string[]> = {
  [AssetRequestStatus.OPEN]: [AssetRequestDecision.IN_PROGRESS, AssetRequestDecision.RESOLVED, AssetRequestDecision.REJECTED],
  [AssetRequestStatus.IN_PROGRESS]: [AssetRequestDecision.RESOLVED, AssetRequestDecision.REJECTED],
};

/**
 * Repair, replacement and damage requests on assets: an employee raises one
 * for an asset they have, and IT / Admin works it through to resolved or
 * rejected. A request is a ticket — it never changes the asset by itself. IT /
 * Admin sends the asset for maintenance, marks it damaged or hands over a
 * replacement with the usual asset actions, and records the outcome here.
 */
@Injectable()
export class AssetRequestService {
  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly self: AssetSelfService,
  ) {}

  private fail(status: HttpStatus, message: string): never {
    throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, message, status);
  }

  private toRow(request: any) {
    return {
      id: request.id,
      type: request.type,
      status: request.status,
      description: request.description,
      resolutionNote: request.resolutionNote ?? null,
      handledBy: request.handledBy ?? null,
      resolvedAt: request.resolvedAt ?? null,
      createdAt: request.createdAt,
      asset: request.asset
        ? { id: request.asset.id, assetCode: request.asset.assetCode, name: request.asset.name, serialNumber: request.asset.serialNumber ?? null, status: request.asset.status }
        : null,
      employee: request.employee
        ? { employeeId: request.employee.id, name: fullName(request.employee), employeeCode: request.employee.employeeCode ?? null }
        : null,
    };
  }

  private async includes(tenantId: string) {
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    return [
      { model: Asset, as: 'asset', attributes: ['id', 'assetCode', 'name', 'serialNumber', 'status'], required: false },
      { model: Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'], required: false },
    ];
  }

  // ==========================================
  // Employee
  // ==========================================

  /** Raises a request for one of my own assets. One open request of a kind per asset: a second would only be noise. */
  async createMyRequest(actor: AssetActorDto, dto: CreateAssetRequestDto) {
    const { tenantId } = actor;
    const employee = await this.self.me(actor);
    const Asset = await this.modelProvider.getAssetModel(tenantId);
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);

    const asset: any = await Asset.findOne({ where: { id: dto.assetId, tenantId, assignedEmployeeId: employee.id }, attributes: ['id', 'status'] });
    if (!asset) this.fail(HttpStatus.NOT_FOUND, `Asset '${dto.assetId}' is not one of your assets.`);
    if (asset.status === AssetStatus.DISPOSED) this.fail(HttpStatus.CONFLICT, 'This asset has been disposed of.');

    const duplicate = await Request.findOne({
      where: { tenantId, assetId: dto.assetId, employeeId: employee.id, type: dto.type, status: { [Op.in]: OPEN_STATUSES } },
      attributes: ['id'],
    });
    if (duplicate) this.fail(HttpStatus.CONFLICT, 'You already have an open request of this kind for this asset. IT / Admin is on it.');

    const created: any = await Request.create(
      { tenantId, assetId: dto.assetId, employeeId: employee.id, type: dto.type, status: AssetRequestStatus.OPEN, description: dto.description.trim() } as any,
    );
    const request = await Request.findOne({ where: { id: created.id, tenantId }, include: await this.includes(tenantId) });
    return this.toRow(request);
  }

  /** My requests, newest first. */
  async getMyRequests(actor: AssetActorDto) {
    const { tenantId } = actor;
    const employee = await this.self.me(actor);
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);
    const requests = (await Request.findAll({
      where: { tenantId, employeeId: employee.id },
      include: await this.includes(tenantId),
      order: [['createdAt', 'DESC']],
      limit: MY_REQUESTS_LIMIT,
    })) as any[];
    return {
      data: requests.map((request) => this.toRow(request)),
      summary: { open: requests.filter((request) => OPEN_STATUSES.includes(request.status)).length },
    };
  }

  // ==========================================
  // IT / Admin
  // ==========================================

  /** The queue: filtered, searched and paged, newest first, with how many are open. */
  async getRequests(tenantId: string, query: GetAssetRequestsQueryDto = {}) {
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 10;

    const where: Record<string | symbol, unknown> = { tenantId };
    if (query.status && query.status !== 'ALL') where.status = query.status;
    if (query.type) where.type = query.type;
    const term = query.search?.trim();
    if (term) {
      const like = `%${ESCAPE(term)}%`;
      where[Op.or] = [
        { description: { [Op.iLike]: like } },
        { '$employee.firstName$': { [Op.iLike]: like } },
        { '$employee.lastName$': { [Op.iLike]: like } },
        { '$asset.name$': { [Op.iLike]: like } },
        { '$asset.assetCode$': { [Op.iLike]: like } },
        { '$asset.serialNumber$': { [Op.iLike]: like } },
      ];
    }

    const [{ rows, count }, counts] = await Promise.all([
      Request.findAndCountAll({
        where: where as any,
        include: await this.includes(tenantId),
        // Newest first.
        order: [['createdAt', 'DESC'], ['id', 'ASC']],
        limit,
        offset: (page - 1) * limit,
        distinct: true,
      }),
      Request.sequelize!.query(
        `SELECT status, COUNT(*)::int AS "count" FROM asset_requests WHERE "tenantId" = :tenantId GROUP BY status`,
        { replacements: { tenantId }, type: QueryTypes.SELECT },
      ) as Promise<{ status: string; count: number }[]>,
    ]);
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));

    return {
      data: (rows as any[]).map((request) => this.toRow(request)),
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit) || 1,
      summary: {
        open: byStatus.get(AssetRequestStatus.OPEN) ?? 0,
        inProgress: byStatus.get(AssetRequestStatus.IN_PROGRESS) ?? 0,
        resolved: byStatus.get(AssetRequestStatus.RESOLVED) ?? 0,
        rejected: byStatus.get(AssetRequestStatus.REJECTED) ?? 0,
      },
    };
  }

  /**
   * What is waiting for IT / Admin, for the notification bell: requests nobody
   * has picked up, requests being worked on, and deductions awaiting a
   * decision. Counts only — the bell polls this, as it does the leave and
   * document counts, so the queue itself is not loaded.
   */
  async getAlerts(tenantId: string) {
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);
    const Flag = await this.modelProvider.getAssetDeductionFlagModel(tenantId);

    const [open, inProgress, pendingDeductions, latest] = await Promise.all([
      Request.count({ where: { tenantId, status: AssetRequestStatus.OPEN } }),
      Request.count({ where: { tenantId, status: AssetRequestStatus.IN_PROGRESS } }),
      Flag.count({ where: { tenantId, status: 'PENDING' } }),
      Request.findOne({
        where: { tenantId, status: AssetRequestStatus.OPEN },
        include: await this.includes(tenantId),
        order: [['createdAt', 'DESC']],
      }),
    ]);

    return {
      openRequests: open,
      inProgressRequests: inProgress,
      pendingDeductions,
      // The newest request waiting, so the bell can say who it is from.
      latestRequest: latest ? this.toRow(latest) : null,
    };
  }

  /** Moves a request along. Rejecting needs a reason the employee can read. */
  async updateRequest(actor: AssetActorDto, requestId: string, dto: UpdateAssetRequestDto) {
    const { tenantId } = actor;
    const Request = await this.modelProvider.getAssetRequestModel(tenantId);
    const request: any = await Request.findOne({ where: { id: requestId, tenantId } });
    if (!request) this.fail(HttpStatus.NOT_FOUND, `Request '${requestId}' not found in this organization.`);

    if (!TRANSITIONS[request.status]) {
      this.fail(HttpStatus.CONFLICT, `This request is already ${request.status === AssetRequestStatus.RESOLVED ? 'resolved' : 'rejected'}.`);
    }
    if (!TRANSITIONS[request.status].includes(dto.status)) {
      this.fail(HttpStatus.CONFLICT, 'This request is already in progress.');
    }
    if (dto.status === AssetRequestDecision.REJECTED && !dto.resolutionNote) {
      this.fail(HttpStatus.BAD_REQUEST, 'Say why the request is being rejected.');
    }

    const decided = dto.status !== AssetRequestDecision.IN_PROGRESS;
    await request.update({
      status: dto.status,
      resolutionNote: dto.resolutionNote ?? request.resolutionNote ?? null,
      handledBy: actor.email ?? null,
      resolvedAt: decided ? new Date() : null,
    });
    const updated = await Request.findOne({ where: { id: requestId, tenantId }, include: await this.includes(tenantId) });
    return this.toRow(updated);
  }
}
