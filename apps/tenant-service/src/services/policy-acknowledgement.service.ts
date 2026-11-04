import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import {
  CompanyDocumentStatus,
  EmployeeNotificationKind,
  EmployeeStatus,
  GetMyPoliciesQueryDto,
  GetPolicyAcknowledgementsQueryDto,
  PolicyActorDto,
  PolicyAcknowledgementFilter,
  PolicyAcknowledgementStatus,
  SetPolicyDistributionDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, formatDay, fullName, todayIso, workspaceError } from './workspace-shared';
import { addDays } from './learning-shared';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
/** More people than this in one audience is not read in full: the counts and lists stop here. */
const AUDIENCE_CAP = 5000;
const MAX_DOCUMENTS = 500;
/** A reminder goes out once the deadline is this close. */
const DUE_SOON_DAYS = 3;

export interface PolicyAudience {
  departmentIds: string[];
  employeeIds: string[];
}

/** No audience, or one naming nobody, means everyone. */
export const normalizeAudience = (audience: { departmentIds?: string[]; employeeIds?: string[] } | null | undefined): PolicyAudience | null => {
  const departmentIds = [...new Set(audience?.departmentIds ?? [])];
  const employeeIds = [...new Set(audience?.employeeIds ?? [])];
  return departmentIds.length || employeeIds.length ? { departmentIds, employeeIds } : null;
};

/** Whether this person is someone the document was sent to. */
export const inAudience = (audience: PolicyAudience | null | undefined, employee: { id: string; departmentId?: string | null }): boolean => {
  if (!audience) return true;
  return audience.employeeIds.includes(employee.id) || Boolean(employee.departmentId && audience.departmentIds.includes(employee.departmentId));
};

/**
 * Sending a company document to part of the organization, and asking people to
 * acknowledge it. The audience is worked out when it is read: someone who
 * joins a chosen department later is included, someone who leaves is not.
 * An acknowledgement is for one version of the document; when the file is
 * replaced or the document is sent again, the version goes up and everyone is
 * asked afresh.
 */
@Injectable()
export class PolicyAcknowledgementService {
  private readonly logger = new Logger(PolicyAcknowledgementService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  // ==========================================
  // Who the document is for
  // ==========================================

  /** The people a document reaches: employed, and in the audience (everyone when there is none). */
  async members(tenantId: string, audience: PolicyAudience | null): Promise<any[]> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const where: Record<string | symbol, unknown> = { tenantId, status: { [Op.in]: EMPLOYED } };
    if (audience) {
      where[Op.or] = [
        ...(audience.departmentIds.length ? [{ departmentId: { [Op.in]: audience.departmentIds } }] : []),
        ...(audience.employeeIds.length ? [{ id: { [Op.in]: audience.employeeIds } }] : []),
      ];
    }
    return (await Employee.findAll({
      where: where as any,
      attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'avatarUrl', 'departmentId'],
      order: [['firstName', 'ASC'], ['lastName', 'ASC'], ['id', 'ASC']],
      limit: AUDIENCE_CAP,
    })) as any[];
  }

  private audienceOf(doc: any): PolicyAudience | null {
    return normalizeAudience(doc.audience);
  }

  private versionOf(doc: any): number {
    return Number(doc.acknowledgementVersion ?? 1);
  }

  private async findDocument(tenantId: string, documentId: string) {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const doc: any = await Doc.findOne({ where: { id: documentId, tenantId } });
    if (!doc) workspaceError('Document not found.', HttpStatus.NOT_FOUND);
    return doc;
  }

  private async acknowledgedIds(tenantId: string, doc: any, employeeIds?: string[]): Promise<Map<string, Date>> {
    const Ack = await this.modelProvider.getCompanyDocumentAcknowledgementModel(tenantId);
    const rows: any[] = (await Ack.findAll({
      where: { tenantId, documentId: doc.id, version: this.versionOf(doc), ...(employeeIds ? { employeeId: { [Op.in]: employeeIds } } : {}) },
      attributes: ['employeeId', 'acknowledgedAt'],
      raw: true,
    })) as any[];
    return new Map(rows.map((row) => [row.employeeId as string, row.acknowledgedAt as Date]));
  }

  private statusOf(acknowledged: boolean, acknowledgeBy: string | null | undefined, today: string): PolicyAcknowledgementStatus {
    if (acknowledged) return PolicyAcknowledgementStatus.ACKNOWLEDGED;
    return acknowledgeBy && acknowledgeBy < today ? PolicyAcknowledgementStatus.OVERDUE : PolicyAcknowledgementStatus.PENDING;
  }

  /** How the document is sent and how far people have got. */
  private async distributionView(tenantId: string, doc: any) {
    const audience = this.audienceOf(doc);
    const requires = doc.requiresAcknowledgement === true;
    const today = todayIso();
    let counts = { audienceCount: 0, acknowledged: 0, pending: 0, overdue: 0 };
    if (requires) {
      const members = await this.members(tenantId, audience);
      const acked = await this.acknowledgedIds(tenantId, doc, members.map((member) => member.id));
      const acknowledged = members.filter((member) => acked.has(member.id)).length;
      const open = members.length - acknowledged;
      const overdue = doc.acknowledgeBy && doc.acknowledgeBy < today ? open : 0;
      counts = { audienceCount: members.length, acknowledged, pending: open - overdue, overdue };
    } else {
      counts.audienceCount = (await this.members(tenantId, audience)).length;
    }
    return {
      documentId: doc.id as string,
      name: doc.name as string,
      status: doc.status as string,
      requiresAcknowledgement: requires,
      audience,
      acknowledgeBy: (doc.acknowledgeBy ?? null) as string | null,
      version: this.versionOf(doc),
      ...counts,
    };
  }

  // ==========================================
  // Notices
  // ==========================================

  private async notify(tenantId: string, rows: { employeeId: string; title: string; body: string }[]): Promise<number> {
    if (!rows.length) return 0;
    try {
      const Notification = await this.modelProvider.getEmployeeNotificationModel(tenantId);
      for (let index = 0; index < rows.length; index += 500) {
        await Notification.bulkCreate(
          rows.slice(index, index + 500).map((row) => ({ tenantId, kind: EmployeeNotificationKind.POLICY, readAt: null, ...row })) as any[],
        );
      }
      return rows.length;
    } catch (error: any) {
      this.logger.warn(`Policy notifications were not saved for tenant ${tenantId}: ${error?.message ?? error}`);
      return 0;
    }
  }

  private dueText(doc: any): string {
    return doc.acknowledgeBy ? ` by ${formatDay(doc.acknowledgeBy)}` : '';
  }

  /** Asks the audience (or just some of it) to read and acknowledge the document. Best effort. */
  async announce(tenantId: string, doc: any, onlyEmployeeIds?: string[], prefix = 'Policy to acknowledge'): Promise<number> {
    try {
      if (doc.requiresAcknowledgement !== true || doc.status !== CompanyDocumentStatus.PUBLISHED) return 0;
      let members = await this.members(tenantId, this.audienceOf(doc));
      if (onlyEmployeeIds) members = members.filter((member) => onlyEmployeeIds.includes(member.id));
      const acked = await this.acknowledgedIds(tenantId, doc, members.map((member) => member.id));
      return await this.notify(
        tenantId,
        members
          .filter((member) => !acked.has(member.id))
          .map((member) => ({
            employeeId: member.id as string,
            title: `${prefix}: ${doc.name}`,
            body: `Please read it and acknowledge${this.dueText(doc)}. Open My Policies.`,
          })),
      );
    } catch (error: any) {
      this.logger.warn(`Policy announcement for ${doc?.id} skipped: ${error?.message ?? error}`);
      return 0;
    }
  }

  // ==========================================
  // HR: sending a document
  // ==========================================

  private async assertAudienceExists(tenantId: string, audience: PolicyAudience | null) {
    if (!audience) return;
    if (audience.departmentIds.length) {
      const Department = await this.modelProvider.getDepartmentModel(tenantId);
      const found = await Department.count({ where: { tenantId, id: { [Op.in]: audience.departmentIds } } });
      if (found !== audience.departmentIds.length) workspaceError('A selected department was not found in this organization.', HttpStatus.BAD_REQUEST);
    }
    if (audience.employeeIds.length) {
      const Employee = await this.modelProvider.getEmployeeModel(tenantId);
      const found = await Employee.count({ where: { tenantId, id: { [Op.in]: audience.employeeIds } } });
      if (found !== audience.employeeIds.length) workspaceError('A selected employee was not found in this organization.', HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Who the document is for, whether it asks for acknowledgement, and by when.
   * Turning acknowledgement on, or widening the audience while it is on, asks
   * the people newly reached; nothing is sent for a draft.
   */
  async setDistribution(actor: PolicyActorDto, documentId: string, dto: SetPolicyDistributionDto) {
    const { tenantId } = actor;
    const doc = await this.findDocument(tenantId, documentId);
    const today = todayIso();
    if (dto.acknowledgeBy && dto.acknowledgeBy < today) workspaceError('The date cannot be in the past.', HttpStatus.BAD_REQUEST);

    const wasRequired = doc.requiresAcknowledgement === true;
    const before = this.audienceOf(doc);
    const after = dto.audience !== undefined ? normalizeAudience(dto.audience) : before;
    await this.assertAudienceExists(tenantId, after);
    const required = dto.requiresAcknowledgement ?? wasRequired;
    if (!required && dto.acknowledgeBy) workspaceError('A deadline only applies when acknowledgement is required.', HttpStatus.BAD_REQUEST);

    const next = {
      requiresAcknowledgement: required,
      audience: after,
      acknowledgeBy: required ? (dto.acknowledgeBy !== undefined ? dto.acknowledgeBy : (doc.acknowledgeBy ?? null)) : null,
    };
    const changes = diffFields(
      { requiresAcknowledgement: wasRequired, audience: before, acknowledgeBy: doc.acknowledgeBy ?? null },
      next as any,
    );
    if (Object.keys(changes).length) {
      const reached = required && doc.status === CompanyDocumentStatus.PUBLISHED ? await this.members(tenantId, after) : [];
      const already = wasRequired && doc.status === CompanyDocumentStatus.PUBLISHED ? new Set((await this.members(tenantId, before)).map((m) => m.id)) : new Set<string>();
      await doc.update(next);
      await writeAudit(this.modelProvider, this.logger, tenantId, 'company_documents', documentId, 'UPDATE', changes);
      const newly = reached.map((member) => member.id as string).filter((id) => !already.has(id));
      if (newly.length) await this.announce(tenantId, doc, newly);
    }
    return this.distributionView(tenantId, doc);
  }

  /** Asks everyone again, for example after the policy was reworded. The earlier acknowledgements stay as the record. */
  async requestReacknowledgement(actor: PolicyActorDto, documentId: string) {
    const { tenantId } = actor;
    const doc = await this.findDocument(tenantId, documentId);
    if (doc.requiresAcknowledgement !== true) workspaceError('This document does not ask for acknowledgement.', HttpStatus.CONFLICT);
    if (doc.status !== CompanyDocumentStatus.PUBLISHED) workspaceError('Only a published document can be sent again.', HttpStatus.CONFLICT);

    const version = this.versionOf(doc) + 1;
    await doc.update({ acknowledgementVersion: version });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'company_documents', documentId, 'UPDATE', {
      acknowledgementVersion: { from: version - 1, to: version },
    });
    await this.announce(tenantId, doc, undefined, 'Please acknowledge again');
    return this.distributionView(tenantId, doc);
  }

  /** Who has and has not acknowledged the current version. */
  async getAcknowledgements(tenantId: string, documentId: string, query: GetPolicyAcknowledgementsQueryDto = {}) {
    const doc = await this.findDocument(tenantId, documentId);
    const today = todayIso();
    const members = await this.members(tenantId, this.audienceOf(doc));
    const acked = await this.acknowledgedIds(tenantId, doc, members.map((member) => member.id));
    const Department = await this.modelProvider.getDepartmentModel(tenantId);
    const departmentIds = [...new Set(members.map((member) => member.departmentId).filter(Boolean))] as string[];
    const departments = departmentIds.length
      ? ((await Department.findAll({ where: { tenantId, id: { [Op.in]: departmentIds } }, attributes: ['id', 'name'], raw: true })) as unknown as { id: string; name: string }[])
      : [];
    const departmentName = new Map(departments.map((department) => [department.id, department.name]));

    let rows = members.map((member) => {
      const at = acked.get(member.id) ?? null;
      return {
        employee: {
          employeeId: member.id as string,
          name: fullName(member),
          employeeCode: (member.employeeCode ?? null) as string | null,
          avatarUrl: (member.avatarUrl ?? null) as string | null,
          department: member.departmentId ? (departmentName.get(member.departmentId) ?? null) : null,
        },
        status: this.statusOf(Boolean(at), doc.acknowledgeBy, today),
        acknowledgedAt: at,
      };
    });
    const summary = {
      audience: rows.length,
      acknowledged: rows.filter((row) => row.status === PolicyAcknowledgementStatus.ACKNOWLEDGED).length,
      pending: rows.filter((row) => row.status === PolicyAcknowledgementStatus.PENDING).length,
      overdue: rows.filter((row) => row.status === PolicyAcknowledgementStatus.OVERDUE).length,
    };

    if (query.status && query.status !== PolicyAcknowledgementFilter.ALL) rows = rows.filter((row) => (row.status as string) === (query.status as string));
    const term = query.search?.trim().toLowerCase();
    if (term) rows = rows.filter((row) => row.employee.name.toLowerCase().includes(term) || (row.employee.employeeCode ?? '').toLowerCase().includes(term));

    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 25;
    return {
      distribution: {
        requiresAcknowledgement: doc.requiresAcknowledgement === true,
        audience: this.audienceOf(doc),
        acknowledgeBy: (doc.acknowledgeBy ?? null) as string | null,
        version: this.versionOf(doc),
      },
      data: rows.slice((page - 1) * limit, page * limit),
      total: rows.length,
      page,
      limit,
      totalPages: Math.ceil(rows.length / limit) || 1,
      summary,
    };
  }

  /** The published documents that ask for acknowledgement, with how far people have got. */
  async overview(tenantId: string) {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const docs: any[] = (await Doc.findAll({
      where: { tenantId, status: CompanyDocumentStatus.PUBLISHED, requiresAcknowledgement: true },
      order: [['updatedAt', 'DESC']],
      limit: MAX_DOCUMENTS,
    })) as any[];
    const data = [];
    for (const doc of docs) {
      const view = await this.distributionView(tenantId, doc);
      data.push({
        documentId: view.documentId,
        name: view.name,
        category: doc.category as string,
        acknowledgeBy: view.acknowledgeBy,
        version: view.version,
        audienceCount: view.audienceCount,
        acknowledged: view.acknowledged,
        pending: view.pending,
        overdue: view.overdue,
      });
    }
    return {
      data,
      summary: {
        documents: data.length,
        pending: data.reduce((sum, row) => sum + row.pending, 0),
        overdue: data.reduce((sum, row) => sum + row.overdue, 0),
      },
    };
  }

  /** Nudges everyone who has not acknowledged yet, now. */
  async remind(actor: PolicyActorDto, documentId: string) {
    const doc = await this.findDocument(actor.tenantId, documentId);
    if (doc.requiresAcknowledgement !== true) workspaceError('This document does not ask for acknowledgement.', HttpStatus.CONFLICT);
    if (doc.status !== CompanyDocumentStatus.PUBLISHED) workspaceError('Only a published document can be reminded about.', HttpStatus.CONFLICT);
    return { reminded: await this.announce(actor.tenantId, doc, undefined, 'Reminder') };
  }

  // ==========================================
  // Employee: My Policies
  // ==========================================

  private async me(actor: PolicyActorDto) {
    const { tenantId, userId, email } = actor;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    let employee: any = userId ? await Employee.findOne({ where: { tenantId, userId }, attributes: ['id', 'departmentId'] }) : null;
    if (!employee && email?.trim()) {
      employee = await Employee.findOne({ where: { tenantId, email: { [Op.iLike]: email.trim() } }, attributes: ['id', 'departmentId'] });
    }
    if (!employee) workspaceError('No employee profile is linked to this login.', HttpStatus.NOT_FOUND);
    return employee;
  }

  /** The employee behind a login, or null when there is none (a document with an audience is then not theirs). */
  async viewerOf(tenantId: string, userId?: string, email?: string): Promise<{ id: string; departmentId: string | null } | null> {
    try {
      return await this.me({ tenantId, userId, email });
    } catch {
      return null;
    }
  }

  private myRow(doc: any, acked: Date | undefined, today: string) {
    const requires = doc.requiresAcknowledgement === true;
    return {
      id: doc.id as string,
      name: doc.name as string,
      category: doc.category as string,
      description: (doc.description ?? null) as string | null,
      fileId: doc.fileId as string,
      fileName: doc.fileName as string,
      mimeType: (doc.mimeType ?? null) as string | null,
      sizeBytes: Number(doc.sizeBytes ?? 0),
      publishedAt: (doc.publishedAt ?? null) as Date | null,
      requiresAcknowledgement: requires,
      acknowledged: requires ? Boolean(acked) : null,
      acknowledgedAt: (acked ?? null) as Date | null,
      acknowledgeBy: requires ? ((doc.acknowledgeBy ?? null) as string | null) : null,
      overdue: requires && !acked && Boolean(doc.acknowledgeBy) && doc.acknowledgeBy < today,
    };
  }

  /** The published documents meant for me, those waiting for my acknowledgement first. */
  async getMine(actor: PolicyActorDto, query: GetMyPoliciesQueryDto = {}) {
    const { tenantId } = actor;
    const me = await this.me(actor);
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const Ack = await this.modelProvider.getCompanyDocumentAcknowledgementModel(tenantId);
    const today = todayIso();

    const docs: any[] = ((await Doc.findAll({ where: { tenantId, status: CompanyDocumentStatus.PUBLISHED }, order: [['updatedAt', 'DESC']], limit: MAX_DOCUMENTS })) as any[]).filter(
      (doc) => inAudience(this.audienceOf(doc), me),
    );
    const mine: any[] = docs.length
      ? ((await Ack.findAll({ where: { tenantId, employeeId: me.id, documentId: { [Op.in]: docs.map((doc) => doc.id) } }, attributes: ['documentId', 'version', 'acknowledgedAt'], raw: true })) as any[])
      : [];
    const ackedAt = (doc: any): Date | undefined => mine.find((row) => row.documentId === doc.id && Number(row.version) === this.versionOf(doc))?.acknowledgedAt;

    let rows = docs.map((doc) => this.myRow(doc, ackedAt(doc), today));
    const summary = {
      total: rows.length,
      pending: rows.filter((row) => row.requiresAcknowledgement && !row.acknowledged).length,
      overdue: rows.filter((row) => row.overdue).length,
      acknowledged: rows.filter((row) => row.acknowledged).length,
    };
    if (query.status === 'PENDING') rows = rows.filter((row) => row.requiresAcknowledgement && !row.acknowledged);
    if (query.status === 'ACKNOWLEDGED') rows = rows.filter((row) => row.acknowledged);
    const term = query.search?.trim().toLowerCase();
    if (term) rows = rows.filter((row) => row.name.toLowerCase().includes(term));
    rows.sort((a, b) => Number(Boolean(b.requiresAcknowledgement && !b.acknowledged)) - Number(Boolean(a.requiresAcknowledgement && !a.acknowledged)) || a.name.localeCompare(b.name));
    return { data: rows, summary };
  }

  /** I have read it and accept it. Doing it again changes nothing. */
  async acknowledge(actor: PolicyActorDto, documentId: string) {
    const { tenantId } = actor;
    const me = await this.me(actor);
    const doc = await this.findDocument(tenantId, documentId);
    if (doc.status !== CompanyDocumentStatus.PUBLISHED || !inAudience(this.audienceOf(doc), me)) {
      workspaceError('Document not found.', HttpStatus.NOT_FOUND);
    }
    if (doc.requiresAcknowledgement !== true) workspaceError('This document does not ask for acknowledgement.', HttpStatus.CONFLICT);

    const Ack = await this.modelProvider.getCompanyDocumentAcknowledgementModel(tenantId);
    const version = this.versionOf(doc);
    const [row, created] = (await Ack.findOrCreate({
      where: { tenantId, documentId, employeeId: me.id, version },
      defaults: { tenantId, documentId, employeeId: me.id, version, acknowledgedAt: new Date() } as any,
    })) as unknown as [any, boolean];
    if (created) {
      await writeAudit(this.modelProvider, this.logger, tenantId, 'company_document_acknowledgements', row.id, 'CREATE', {
        document: { from: null, to: doc.name },
        version: { from: null, to: version },
        employeeId: { from: null, to: me.id },
      });
    }
    return this.myRow(doc, row.acknowledgedAt, todayIso());
  }

  // ==========================================
  // Reminders on the deadline
  // ==========================================

  /**
   * Deadline notices for one organization: "due soon" once the deadline is
   * within a few days, "overdue" once it has passed. Each goes to a person once
   * for each version of a document. Returns how many were sent.
   */
  async sendReminders(tenantId: string, today: string = todayIso()): Promise<number> {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const Notice = await this.modelProvider.getCompanyDocumentAckNoticeModel(tenantId);
    const docs: any[] = (await Doc.findAll({
      where: {
        tenantId,
        status: CompanyDocumentStatus.PUBLISHED,
        requiresAcknowledgement: true,
        acknowledgeBy: { [Op.ne]: null, [Op.lte]: addDays(today, DUE_SOON_DAYS) },
      },
      limit: MAX_DOCUMENTS,
    })) as any[];

    let sent = 0;
    for (const doc of docs) {
      const overdue = doc.acknowledgeBy < today;
      const kind = overdue ? 'OVERDUE' : 'DUE_SOON';
      const version = this.versionOf(doc);
      const members = await this.members(tenantId, this.audienceOf(doc));
      const acked = await this.acknowledgedIds(tenantId, doc, members.map((member) => member.id));
      const told = new Set(
        ((await Notice.findAll({ where: { tenantId, documentId: doc.id, version, kind }, attributes: ['employeeId'], raw: true })) as unknown as { employeeId: string }[]).map((row) => row.employeeId),
      );
      const targets = members.filter((member) => !acked.has(member.id) && !told.has(member.id));
      if (!targets.length) continue;

      const written = await this.notify(
        tenantId,
        targets.map((member) => ({
          employeeId: member.id as string,
          title: overdue ? `Acknowledgement overdue: ${doc.name}` : `Acknowledge by ${formatDay(doc.acknowledgeBy)}: ${doc.name}`,
          body: overdue
            ? `You were asked to acknowledge it by ${formatDay(doc.acknowledgeBy)}. Open My Policies and do it now.`
            : 'Please read it and acknowledge before the deadline. Open My Policies.',
        })),
      );
      // Stamp only after the notices are saved, so a failure is tried again on the next run.
      if (written > 0) {
        await Notice.bulkCreate(targets.map((member) => ({ tenantId, documentId: doc.id, employeeId: member.id, version, kind })) as any[], { ignoreDuplicates: true });
        sent += written;
      }
    }
    return sent;
  }
}
