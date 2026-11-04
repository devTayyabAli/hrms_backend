import { Injectable, Logger } from '@nestjs/common';
import { Op } from 'sequelize';
import { EmployeeStatus } from '@app/common';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { KpiTemplateService } from './kpi-template.service';
import { equalShares, scaleWeights } from './performance-consolidation';
import { writePayrollAudit as writeAudit } from './payroll-access';

const EMPLOYED = [EmployeeStatus.ACTIVE, EmployeeStatus.ON_LEAVE];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Someone with more than one role (an additional assignment as well as their
 * primary position) gets KPIs for each role, and where an additional role has
 * its own manager, that manager evaluates it. Nothing here makes a second
 * employee profile: the roles are read from the employee's own additional
 * assignments. Done when they are enrolled in a cycle that asks for it
 * (`includeAdditionalRoles`), after the primary KPIs are in.
 *
 * The plan still adds up to 100: each role takes an equal share, split across
 * that role's KPIs in proportion to their template weights. Where roles have
 * their own evaluators, each evaluator's share of the final rating is the share
 * of the roles they evaluate (HR can change it afterwards).
 */
@Injectable()
export class ReviewRolesService {
  private readonly logger = new Logger(ReviewRolesService.name);

  constructor(
    private readonly modelProvider: TenantModelProviderService,
    private readonly templates: KpiTemplateService,
  ) {}

  /** The running additional assignments of someone, oldest first. */
  private async assignmentsOf(tenantId: string, employeeId: string): Promise<any[]> {
    try {
      const Assignment = await this.modelProvider.getEmployeeAssignmentModel(tenantId);
      const rows = (await Assignment.findAll({ where: { tenantId, employeeId } })) as any[];
      return rows.filter((row) => !row.endDate || String(row.endDate).slice(0, 10) >= today()).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
    } catch {
      return [];
    }
  }

  /**
   * Adds the KPIs of each additional role, tags them with the role, rebalances the
   * plan to 100, and adds each additional manager as an evaluator. Returns what it did.
   */
  async enrolRoles(
    tenantId: string,
    review: { id: string; employeeId: string; cycleId?: string | null },
    employee: any,
    leadReviewerId: string | null,
    primaryTemplateId: string | null,
  ): Promise<{ roles: number; evaluators: number }> {
    try {
      const assignments = await this.assignmentsOf(tenantId, review.employeeId);
      if (!assignments.length) return { roles: 0, evaluators: 0 };

      const Kpi = await this.modelProvider.getReviewKpiModel(tenantId);
      const Department = await this.modelProvider.getDepartmentModel(tenantId);
      const roleTemplates: { template: any; label: string; managerId: string | null }[] = [];
      const seen = new Set<string>(primaryTemplateId ? [primaryTemplateId] : []);
      for (const assignment of assignments) {
        if (!assignment.departmentId && !assignment.designationId) continue;
        const template = await this.templates.templateFor(tenantId, { departmentId: assignment.departmentId, designationId: assignment.designationId });
        if (!template || seen.has(template.id)) continue;
        seen.add(template.id);
        const department: any = assignment.departmentId ? await Department.findOne({ where: { id: assignment.departmentId, tenantId }, attributes: ['name'], raw: true }) : null;
        roleTemplates.push({ template, label: String(assignment.title || department?.name || 'Additional role').slice(0, 120), managerId: assignment.reportingManagerId ?? null });
      }
      if (!roleTemplates.length) return { roles: 0, evaluators: 0 };

      // Every role takes an equal share of the plan: the primary position first.
      const primaryKpis = ((await Kpi.findAll({ where: { tenantId, reviewId: review.id } })) as any[]).sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
      const shares = equalShares((primaryKpis.length ? 1 : 0) + roleTemplates.length);
      let shareIndex = 0;
      if (primaryKpis.length) {
        const scaled = scaleWeights(primaryKpis.map((kpi) => Number(kpi.weight)), shares[shareIndex++]);
        for (const [index, kpi] of primaryKpis.entries()) await kpi.update({ weight: scaled[index], roleLabel: kpi.roleLabel ?? 'Primary role' });
      }

      let order = (primaryKpis.length + 1) * 10;
      const evaluatorWeight = new Map<string, number>();
      for (const role of roleTemplates) {
        const share = shares[shareIndex++];
        const items = Array.isArray(role.template.items) ? role.template.items : [];
        const scaled = scaleWeights(items.map((item: any) => Number(item.weight)), share);
        const managerOk = role.managerId && role.managerId !== review.employeeId && role.managerId !== leadReviewerId ? await this.employed(tenantId, role.managerId) : false;
        await Kpi.bulkCreate(
          items.map((item: any, index: number) => ({
            tenantId,
            employeeId: review.employeeId,
            reviewId: review.id,
            cycleId: review.cycleId ?? null,
            templateId: role.template.id,
            title: item.title,
            description: item.description ?? null,
            weight: scaled[index],
            target: item.target ?? null,
            unit: item.unit ?? null,
            measurement: item.measurement ?? 'NUMBER',
            category: item.category ?? null,
            source: 'TEMPLATE',
            sortOrder: (order += 10),
            roleLabel: role.label,
            evaluatorEmployeeId: managerOk ? role.managerId : null,
          })) as any[],
        );
        if (managerOk && role.managerId) evaluatorWeight.set(role.managerId, (evaluatorWeight.get(role.managerId) ?? 0) + share);
      }

      // Each additional manager evaluates their role(s): the lead keeps what is left.
      let evaluators = 0;
      if (evaluatorWeight.size) {
        const Evaluator = await this.modelProvider.getReviewEvaluatorModel(tenantId);
        const taken = [...evaluatorWeight.values()].reduce((a, b) => a + b, 0);
        const labels = new Map(roleTemplates.filter((role) => role.managerId).map((role) => [role.managerId as string, role.label]));
        if (leadReviewerId) await Evaluator.create({ tenantId, reviewId: review.id, employeeId: leadReviewerId, roleLabel: 'Primary role', isLead: true, weight: 100 - taken, status: 'PENDING' } as any);
        for (const [managerId, weight] of evaluatorWeight) {
          await Evaluator.create({ tenantId, reviewId: review.id, employeeId: managerId, roleLabel: labels.get(managerId) ?? null, isLead: false, weight, status: 'PENDING' } as any);
          evaluators++;
        }
        if (leadReviewerId) {
          const Review = await this.modelProvider.getPerformanceReviewModel(tenantId);
          await Review.update({ multiReviewer: true } as any, { where: { id: review.id, tenantId } as any });
        }
      }
      await writeAudit(this.modelProvider, this.logger, tenantId, 'performance_reviews', review.id, 'UPDATE', {
        event: { from: null, to: 'ROLES_ADDED_TO_PLAN' },
        roles: { from: null, to: roleTemplates.length },
        evaluators: { from: null, to: evaluators },
      });
      return { roles: roleTemplates.length, evaluators };
    } catch (error: any) {
      this.logger.warn(`Additional roles were not added to review ${review.id}: ${error?.message ?? error}`);
      return { roles: 0, evaluators: 0 };
    }
  }

  private async employed(tenantId: string, employeeId: string): Promise<boolean> {
    const Employee = await this.modelProvider.getEmployeeModel(tenantId);
    const row: any = await Employee.findOne({ where: { tenantId, id: { [Op.eq]: employeeId } }, attributes: ['id', 'status'] });
    return Boolean(row && EMPLOYED.includes(row.status));
  }
}
