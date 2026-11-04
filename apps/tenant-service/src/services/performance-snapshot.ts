import { Op } from 'sequelize';
import type { TenantModelProviderService } from './tenant-model-provider.service';

/**
 * What was true about the person when a review was made, kept on the review.
 * Employee Management stays the source of who someone is today; this is what
 * the review must keep saying however the person's department, designation or
 * manager changes afterwards. It is taken when the review is created and again
 * when it is completed, and not touched once it is final.
 */
export interface ReviewSnapshot {
  takenAt: string;
  employee: { id: string; name: string; employeeCode: string | null };
  departmentId: string | null;
  departmentName: string | null;
  designationId: string | null;
  designationTitle: string | null;
  employmentType: string | null;
  reportingManagerId: string | null;
  reportingManagerName: string | null;
  reviewerId: string | null;
  reviewerName: string | null;
}

const nameOf = (row?: { firstName?: string | null; lastName?: string | null } | null) => (row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : null);

/** The snapshot for an employee and the reviewer the review has now. A name that cannot be read stays null: it never blocks a review. */
export const buildReviewSnapshot = async (
  modelProvider: TenantModelProviderService,
  tenantId: string,
  employee: any,
  reviewerId: string | null,
): Promise<ReviewSnapshot> => {
  const lookup = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const Department = await modelProvider.getDepartmentModel(tenantId);
  const Designation = await modelProvider.getDesignationModel(tenantId);
  const Employee = await modelProvider.getEmployeeModel(tenantId);
  const ids = [...new Set([employee.reportingManagerId, reviewerId].filter(Boolean))] as string[];
  const [department, designation, people] = await Promise.all([
    employee.departmentId ? lookup(() => Department.findOne({ where: { id: employee.departmentId, tenantId }, attributes: ['id', 'name'], raw: true }) as Promise<any>) : Promise.resolve(null),
    employee.designationId ? lookup(() => Designation.findOne({ where: { id: employee.designationId, tenantId }, attributes: ['id', 'title'], raw: true }) as Promise<any>) : Promise.resolve(null),
    ids.length ? lookup(() => Employee.findAll({ where: { tenantId, id: { [Op.in]: ids } }, attributes: ['id', 'firstName', 'lastName'], raw: true }) as Promise<any[]>) : Promise.resolve([] as any[]),
  ]);
  const byId = new Map((people ?? []).map((row: any) => [row.id, row]));
  return {
    takenAt: new Date().toISOString(),
    employee: { id: employee.id, name: nameOf(employee) ?? '', employeeCode: employee.employeeCode ?? null },
    departmentId: employee.departmentId ?? null,
    departmentName: department?.name ?? null,
    designationId: employee.designationId ?? null,
    designationTitle: designation?.title ?? null,
    employmentType: employee.employmentType ?? null,
    reportingManagerId: employee.reportingManagerId ?? null,
    reportingManagerName: employee.reportingManagerId ? nameOf(byId.get(employee.reportingManagerId)) : null,
    reviewerId,
    reviewerName: reviewerId ? nameOf(byId.get(reviewerId)) : null,
  };
};
