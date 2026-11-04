import { Op } from 'sequelize';
import type { TenantModelProviderService } from './tenant-model-provider.service';
import type { PolicyStage, RouteLookup } from './approval-engine';

/**
 * Reads the people, titles and department heads a route is worked out from.
 * Each is looked up once per call, however many stages or requests use it.
 */
export const createRouteLookup = async (modelProvider: TenantModelProviderService, tenantId: string): Promise<RouteLookup> => {
  const Employee = await modelProvider.getEmployeeModel(tenantId);
  const people = new Map<string, any>();
  const titles = new Map<string, string | null>();
  return {
    person: async (id) => {
      if (!people.has(id)) {
        people.set(
          id,
          (await Employee.findOne({
            where: { tenantId, id },
            attributes: ['id', 'firstName', 'lastName', 'reportingManagerId', 'designationId', 'departmentId', 'status'],
            raw: true,
          })) ?? null,
        );
      }
      return people.get(id);
    },
    designationTitle: async (designationId) => {
      if (!titles.has(designationId)) {
        const Designation = await modelProvider.getDesignationModel(tenantId);
        const rows = (await Designation.findAll({ where: { tenantId, id: { [Op.in]: [designationId] } }, attributes: ['id', 'title'], raw: true })) as { id: string; title?: string }[];
        titles.set(designationId, rows.find((row) => row.id === designationId)?.title || null);
      }
      return titles.get(designationId) ?? null;
    },
    additionalManager: async (employeeId) => {
      try {
        const Assignment = await modelProvider.getEmployeeAssignmentModel(tenantId);
        const today = new Date().toISOString().slice(0, 10);
        const rows = (await Assignment.findAll({ where: { tenantId, employeeId, reportingManagerId: { [Op.ne]: null } } as any, attributes: ['reportingManagerId', 'startDate', 'endDate'], raw: true })) as unknown as { reportingManagerId: string; startDate: string; endDate: string | null }[];
        const running = rows.filter((row) => !row.endDate || String(row.endDate).slice(0, 10) >= today).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
        return running[0]?.reportingManagerId ?? null;
      } catch {
        return null;
      }
    },
    departmentHead: async (departmentId) => {
      const Department = await modelProvider.getDepartmentModel(tenantId);
      const row: any = await Department.findOne({ where: { tenantId, id: departmentId }, attributes: ['managerId'], raw: true });
      return row?.managerId ?? null;
    },
  };
};

/**
 * The stages an organization saved for a kind of request, or null when it has
 * saved none (a missing table counts as none).
 */
export const loadPolicyStages = async (modelProvider: TenantModelProviderService, tenantId: string, requestType: string): Promise<PolicyStage[] | null> => {
  try {
    const Policy = await modelProvider.getApprovalPolicyModel(tenantId);
    const row: any = await Policy.findOne({ where: { tenantId, requestType }, attributes: ['stages'] });
    return Array.isArray(row?.stages) && row.stages.length ? (row.stages as PolicyStage[]) : null;
  } catch {
    return null;
  }
};
