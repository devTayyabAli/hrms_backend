import { Injectable, Logger } from '@nestjs/common';
import { PolicyStatus } from '@app/common';
import {
  getIndustryTemplate,
  IndustryTemplate,
} from '../data/industry-templates';
import { TenantService } from './tenant.service';
import { TenantModelProviderService } from './tenant-model-provider.service';
import { OrganizationSetupService } from './organization-setup.service';
import { OrganizationPolicyService } from './organization-policy.service';

export interface IndustryTemplatePreview extends IndustryTemplate {
  industry: string;
}

interface ApplySummary {
  created: number;
  skipped: number;
}

export interface ApplyIndustryTemplateResult {
  industry: string;
  departments: ApplySummary;
  designations: ApplySummary;
  leavePolicies: ApplySummary;
  policies: ApplySummary;
}

/**
 * Opt-in "recommended setup" for a new (or already-onboarded) organization —
 * never applied automatically. `getTemplate` is a pure read for the preview
 * screen; `applyTemplate` does the actual seeding, and is safe to call more
 * than once (from onboarding, then again later from Organization Settings)
 * because it skips anything that already exists by name rather than failing.
 *
 * Deliberately reuses `OrganizationSetupService`/`OrganizationPolicyService`'s
 * own create methods rather than inserting rows directly — that's what gives
 * this the same validation (parent-department checks, designation-code
 * uniqueness, policy-configuration shape) as a manually-created record gets.
 */
@Injectable()
export class IndustryTemplateService {
  private readonly logger = new Logger(IndustryTemplateService.name);

  constructor(
    private readonly tenantService: TenantService,
    private readonly modelProvider: TenantModelProviderService,
    private readonly setupService: OrganizationSetupService,
    private readonly policyService: OrganizationPolicyService,
  ) {}

  async getTemplate(tenantId: string): Promise<IndustryTemplatePreview | null> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    const template = getIndustryTemplate(tenant.industry);
    return { industry: tenant.industry ?? 'General', ...template };
  }

  async applyTemplate(
    tenantId: string,
    actorUserId?: string,
  ): Promise<ApplyIndustryTemplateResult> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    const template = getIndustryTemplate(tenant.industry);

    const departmentModel =
      await this.modelProvider.getDepartmentModel(tenantId);
    const designationModel =
      await this.modelProvider.getDesignationModel(tenantId);
    const leavePolicyModel =
      await this.modelProvider.getLeavePolicyModel(tenantId);
    const policyModel =
      await this.modelProvider.getOrganizationPolicyModel(tenantId);

    // Departments first — designations below resolve their departmentId from this.
    const departmentCodeToId = new Map<string, string>();
    const departments: ApplySummary = { created: 0, skipped: 0 };
    for (const dept of template.departments) {
      const existing = await departmentModel.findOne({
        where: { tenantId, name: dept.name },
      });
      if (existing) {
        departmentCodeToId.set(dept.code, existing.id);
        departments.skipped++;
        continue;
      }
      try {
        const created = await this.setupService.createDepartment(tenantId, {
          name: dept.name,
          code: dept.code,
          description: dept.description,
        });
        departmentCodeToId.set(dept.code, created.id);
        departments.created++;
      } catch (deptErr: any) {
        this.logger.warn(
          `Could not seed template department "${dept.name}" for tenant ${tenantId}: ${deptErr?.message}`,
        );
        departments.skipped++;
      }
    }

    const designations: ApplySummary = { created: 0, skipped: 0 };
    for (const desig of template.designations) {
      const departmentId = departmentCodeToId.get(desig.departmentCode);
      if (!departmentId) {
        this.logger.warn(
          `Skipping designation "${desig.title}" — its department (${desig.departmentCode}) was not seeded.`,
        );
        continue;
      }
      const existing = await designationModel.findOne({
        where: { tenantId, title: desig.title },
      });
      if (existing) {
        designations.skipped++;
        continue;
      }
      try {
        await this.setupService.createDesignation(tenantId, {
          title: desig.title,
          code: desig.code,
          departmentId,
        });
        designations.created++;
      } catch (desigErr: any) {
        this.logger.warn(
          `Could not seed template designation "${desig.title}" for tenant ${tenantId}: ${desigErr?.message}`,
        );
        designations.skipped++;
      }
    }

    const leavePolicies: ApplySummary = { created: 0, skipped: 0 };
    for (const leave of template.leavePolicies) {
      const existing = await leavePolicyModel.findOne({
        where: { tenantId, name: leave.name },
      });
      if (existing) {
        leavePolicies.skipped++;
        continue;
      }
      try {
        await this.setupService.createLeavePolicy(tenantId, {
          name: leave.name,
          description: leave.description,
          annualAllocation: leave.annualAllocation,
          isPaid: leave.isPaid,
          accrualType: leave.accrualType,
          carryForwardDays: leave.carryForwardDays ?? undefined,
          eligibility: leave.eligibility,
        });
        leavePolicies.created++;
      } catch (leaveErr: any) {
        this.logger.warn(
          `Could not seed template leave policy "${leave.name}" for tenant ${tenantId}: ${leaveErr?.message}`,
        );
        leavePolicies.skipped++;
      }
    }

    const policies: ApplySummary = { created: 0, skipped: 0 };
    for (const policy of template.policies) {
      try {
        const existingByName = await policyModel.findOne({
          where: { tenantId, name: policy.name },
        });
        const existingByTypeVersion = await policyModel.findOne({
          where: { tenantId, policyType: policy.policyType, version: 1 },
        });
        if (existingByName || existingByTypeVersion) {
          policies.skipped++;
          continue;
        }
        const createdPolicy = await this.policyService.createPolicy(
          tenantId,
          {
            policyType: policy.policyType,
            name: policy.name,
            description: policy.description,
            configuration: policy.configuration,
          },
          actorUserId,
        );
        if (policy.status === PolicyStatus.ACTIVE) {
          await this.policyService.activatePolicy(
            tenantId,
            createdPolicy.id,
            undefined,
            actorUserId,
          );
        }
        policies.created++;
      } catch (policyErr: any) {
        this.logger.warn(
          `Could not seed template policy "${policy.name}" for tenant ${tenantId}: ${policyErr?.message}`,
        );
        policies.skipped++;
      }
    }

    this.logger.log(
      `Applied "${tenant.industry}" template for tenant ${tenantId}: ` +
        `${departments.created} departments, ${designations.created} designations, ` +
        `${leavePolicies.created} leave policies, ${policies.created} policies created.`,
    );

    return {
      industry: tenant.industry,
      departments,
      designations,
      leavePolicies,
      policies,
    };
  }
}
