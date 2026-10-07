import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Op, Sequelize } from 'sequelize';
import {
  CompanyDocumentCategory,
  CompanyDocumentStatus,
  CreateCompanyDocumentDto,
  GetCompanyDocumentsQueryDto,
  UpdateCompanyDocumentDto,
} from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { writePayrollAudit as writeAudit } from './payroll-access';
import { diffFields, employeeInclude, employeeSummary, workspaceError } from './workspace-shared';

/** The library is an organization-level list, small enough to return whole. */
const MAX_DOCUMENTS = 500;

const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export interface CompanyDocumentRow {
  id: string;
  name: string;
  category: CompanyDocumentCategory;
  status: CompanyDocumentStatus;
  owner: ReturnType<typeof employeeSummary>;
  description: string | null;
  fileId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  sizeLabel: string;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Workspace › Documents: the company library. Writes return the id of any
 * stored file that is no longer referenced (a replaced or deleted document's
 * file), so the caller can remove it from the file store.
 */
@Injectable()
export class CompanyDocumentService {
  private readonly logger = new Logger(CompanyDocumentService.name);

  constructor(private readonly modelProvider: TenantModelProviderService) {}

  private toRow(doc: any): CompanyDocumentRow {
    return {
      id: doc.id,
      name: doc.name,
      category: doc.category,
      status: doc.status,
      owner: employeeSummary(doc.owner),
      description: doc.description ?? null,
      fileId: doc.fileId,
      fileName: doc.fileName,
      mimeType: doc.mimeType ?? null,
      sizeBytes: doc.sizeBytes ?? 0,
      sizeLabel: sizeLabel(doc.sizeBytes ?? 0),
      publishedAt: doc.publishedAt ?? null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private where(tenantId: string, query: GetCompanyDocumentsQueryDto, onlyPublished = false) {
    const and: any[] = [{ tenantId }];
    if (onlyPublished) and.push({ status: CompanyDocumentStatus.PUBLISHED });
    else if (query.status) and.push({ status: query.status });
    if (query.category) and.push({ category: query.category });
    const search = query.search?.trim();
    if (search) {
      const like = `%${search}%`;
      and.push({
        [Op.or]: [
          { name: { [Op.iLike]: like } },
          { fileName: { [Op.iLike]: like } },
          Sequelize.where(Sequelize.fn('concat', Sequelize.col('owner.firstName'), ' ', Sequelize.col('owner.lastName')), {
            [Op.iLike]: like,
          }),
        ],
      });
    }
    return { [Op.and]: and };
  }

  private async findRows(tenantId: string, query: GetCompanyDocumentsQueryDto, onlyPublished: boolean) {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const rows = await Doc.findAll({
      where: this.where(tenantId, query, onlyPublished),
      include: [await employeeInclude(this.modelProvider, tenantId, 'owner')],
      order: [['updatedAt', 'DESC']],
      limit: MAX_DOCUMENTS,
      subQuery: false,
    });
    return rows.map((row) => this.toRow(row));
  }

  /** The filtered library plus counts for the whole of it (the KPI row). */
  async getAll(tenantId: string, query: GetCompanyDocumentsQueryDto) {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const [data, byStatus, contracts] = await Promise.all([
      this.findRows(tenantId, query, false),
      Doc.count({ where: { tenantId }, group: ['status'] }) as unknown as Promise<{ status: string; count: number }[]>,
      Doc.count({ where: { tenantId, category: CompanyDocumentCategory.CONTRACT } }),
    ]);
    const count = (status: CompanyDocumentStatus) => Number(byStatus.find((s) => s.status === status)?.count ?? 0);
    return {
      data,
      stats: {
        total: byStatus.reduce((sum, s) => sum + Number(s.count), 0),
        published: count(CompanyDocumentStatus.PUBLISHED),
        drafts: count(CompanyDocumentStatus.DRAFT),
        archived: count(CompanyDocumentStatus.ARCHIVED),
        contracts,
      },
    };
  }

  /** Self-service: published documents only. */
  async getPublished(tenantId: string, query: GetCompanyDocumentsQueryDto) {
    return { data: await this.findRows(tenantId, query, true) };
  }

  private async findOwn(tenantId: string, documentId: string) {
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const doc = await Doc.findOne({
      where: { id: documentId, tenantId },
      include: [await employeeInclude(this.modelProvider, tenantId, 'owner')],
    });
    if (!doc) workspaceError('Document not found.', HttpStatus.NOT_FOUND);
    return doc!;
  }

  private async assertOwner(tenantId: string, employeeId: string | null | undefined) {
    if (!employeeId) return;
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    if (!(await Employee.findOne({ where: { id: employeeId, tenantId }, attributes: ['id'] }))) {
      workspaceError('The selected owner was not found.', HttpStatus.BAD_REQUEST);
    }
  }

  async create(tenantId: string, dto: CreateCompanyDocumentDto, actorUserId?: string) {
    await this.assertOwner(tenantId, dto.ownerEmployeeId);
    const Doc = await this.modelProvider.getCompanyDocumentModel(tenantId);
    const status = dto.status ?? CompanyDocumentStatus.DRAFT;
    const doc = await Doc.create({
      tenantId,
      name: dto.name.trim(),
      category: dto.category,
      status,
      ownerEmployeeId: dto.ownerEmployeeId ?? null,
      description: dto.description?.trim() || null,
      fileId: dto.fileId,
      fileName: dto.fileName,
      mimeType: dto.mimeType ?? null,
      sizeBytes: dto.sizeBytes,
      publishedAt: status === CompanyDocumentStatus.PUBLISHED ? new Date() : null,
      createdByUserId: actorUserId ?? null,
    });
    await writeAudit(this.modelProvider, this.logger, tenantId, 'company_documents', doc.id, 'CREATE', {
      name: { from: null, to: doc.name },
      status: { from: null, to: doc.status },
    });
    return this.toRow(await this.findOwn(tenantId, doc.id));
  }

  async update(tenantId: string, documentId: string, dto: UpdateCompanyDocumentDto) {
    const doc: any = await this.findOwn(tenantId, documentId);
    if (dto.ownerEmployeeId !== undefined) await this.assertOwner(tenantId, dto.ownerEmployeeId);

    const replacingFile = Boolean(dto.fileId && dto.fileId !== doc.fileId);
    const next: Record<string, unknown> = {
      name: dto.name?.trim(),
      category: dto.category,
      status: dto.status,
      ownerEmployeeId: dto.ownerEmployeeId,
      description: dto.description === undefined ? undefined : dto.description?.trim() || null,
      ...(replacingFile
        ? { fileId: dto.fileId, fileName: dto.fileName, mimeType: dto.mimeType ?? null, sizeBytes: dto.sizeBytes ?? 0 }
        : {}),
    };
    const changes = diffFields(doc.get({ plain: true }), next);
    const previousFileId = replacingFile ? doc.fileId : null;
    if (Object.keys(changes).length) {
      if (changes.status && dto.status === CompanyDocumentStatus.PUBLISHED) next.publishedAt = new Date();
      await doc.update(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
      await writeAudit(this.modelProvider, this.logger, tenantId, 'company_documents', documentId, 'UPDATE', changes);
    }
    return { document: this.toRow(await this.findOwn(tenantId, documentId)), previousFileId };
  }

  async remove(tenantId: string, documentId: string) {
    const doc = await this.findOwn(tenantId, documentId);
    await doc.destroy();
    await writeAudit(this.modelProvider, this.logger, tenantId, 'company_documents', documentId, 'DELETE', {
      name: { from: doc.name, to: null },
    });
    return { success: true, fileId: doc.fileId };
  }
}
