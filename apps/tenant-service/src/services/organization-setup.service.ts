import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { PlatformNotifierService } from './platform-notifier.service';
import {
  Tenant,
  TenantStatus,
  TenantSetupStatus,
  TenantProvisioningStatus,
  Department,
  Designation,
} from '../models';
import {
  UpdateOrganizationProfileDto,
  CreateDepartmentDto,
  UpdateDepartmentDto,
  CreateDesignationDto,
  UpdateDesignationDto,
  UpdateWorkingHoursDto,
  CreateLeavePolicyDto,
  UpdateLeavePolicyDto,
  UpdateAttendancePolicyDto,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { TenantService } from './tenant.service';
import { TenantModelProviderService } from './tenant-model-provider.service';

export interface SetupProgressResult {
  tenantId: string;
  organizationName: string;
  status: TenantStatus;
  setupStatus: TenantSetupStatus;
  percentage: number;
  modules: {
    profile: boolean;
    departments: boolean;
    designations: boolean;
    workingHours: boolean;
    leavePolicy: boolean;
    attendancePolicy: boolean;
  };
  missingModules: string[];
  isComplete: boolean;
}

/**
 * Department/Designation/WorkingHours/LeavePolicy/AttendancePolicy all live
 * in each tenant's own physical database (see TenantModelProviderService) —
 * every method here resolves the tenant-scoped model handle first, then
 * queries it. `where: { tenantId }` is kept on every query as a
 * defense-in-depth check, even though the per-tenant database connection is
 * the actual isolation boundary.
 */
@Injectable()
export class OrganizationSetupService {
  private readonly logger = new Logger(OrganizationSetupService.name);

  constructor(
    private tenantService: TenantService,
    private readonly modelProvider: TenantModelProviderService,
    @Optional() private readonly platformNotifier?: PlatformNotifierService,
  ) { }

  /**
   * Get overall Organization Setup Progress
   */
  async getSetupProgress(tenantId: string): Promise<SetupProgressResult> {
    const tenant = await this.tenantService.getTenantById(tenantId);

    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    const designationModel = await this.modelProvider.getDesignationModel(tenantId);
    const workingHoursModel = await this.modelProvider.getWorkingHoursModel(tenantId);
    const leavePolicyModel = await this.modelProvider.getLeavePolicyModel(tenantId);
    const attendancePolicyModel = await this.modelProvider.getAttendancePolicyModel(tenantId);

    const departmentsCount = await departmentModel.count({ where: { tenantId } });
    const designationsCount = await designationModel.count({ where: { tenantId } });
    const workingHours = await workingHoursModel.findOne({ where: { tenantId } });
    const leavePoliciesCount = await leavePolicyModel.count({ where: { tenantId } });
    const attendancePolicy = await attendancePolicyModel.findOne({ where: { tenantId } });

    const profileCompleted = Boolean(
      tenant.organizationName && (tenant.country || tenant.address || tenant.timezone),
    );
    const departmentsCompleted = departmentsCount > 0;
    const designationsCompleted = designationsCount > 0;
    const workingHoursCompleted = Boolean(workingHours);
    const leavePolicyCompleted = leavePoliciesCount > 0;
    const attendancePolicyCompleted = Boolean(attendancePolicy);

    const modules = {
      profile: profileCompleted,
      departments: departmentsCompleted,
      designations: designationsCompleted,
      workingHours: workingHoursCompleted,
      leavePolicy: leavePolicyCompleted,
      attendancePolicy: attendancePolicyCompleted,
    };

    const missingModules: string[] = [];
    if (!profileCompleted) missingModules.push('Profile');
    if (!departmentsCompleted) missingModules.push('Departments');
    if (!designationsCompleted) missingModules.push('Designations');
    if (!workingHoursCompleted) missingModules.push('Working Hours');
    if (!leavePolicyCompleted) missingModules.push('Leave Policy');
    if (!attendancePolicyCompleted) missingModules.push('Attendance Policy');

    const completedCount = Object.values(modules).filter(Boolean).length;
    const percentage = Math.round((completedCount / 6) * 100);
    const isComplete = missingModules.length === 0;

    return {
      tenantId: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      status: tenant.status,
      setupStatus: tenant.setupStatus,
      percentage,
      modules,
      missingModules,
      isComplete,
    };
  }

  /**
   * Update Organization Profile
   */
  /**
   * The Organization Profile as it currently stands.
   *
   * Much of this is already populated by the time the admin reaches the setup
   * wizard — the SuperAdmin supplies the organization name, official email,
   * domain and admin contact when creating the tenant. Without a way to read
   * it back, step 1 of the wizard opened blank and invited the admin to retype
   * information the platform already held (or, worse, to contradict it).
   *
   * Fields are listed explicitly rather than returning the tenant row: that
   * record also carries `databaseConfig`, provisioning state and billing
   * associations, none of which belong in a profile form's response.
   */
  async getOrganizationProfile(tenantId: string) {
    const tenant = await this.tenantService.getTenantById(tenantId);

    return {
      tenantId: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      shortName: tenant.shortName,
      legalName: tenant.legalName,
      officialEmail: tenant.officialEmail || tenant.email,
      phone: tenant.phone,
      website: tenant.website,
      industry: tenant.industry,
      companySize: tenant.companySize,
      country: tenant.country,
      state: tenant.state,
      city: tenant.city,
      address: tenant.address,
      timezone: tenant.timezone,
      currency: tenant.currency,
      logoUrl: tenant.logoUrl,
      createdAt: tenant.createdAt,
    };
  }

  /**
   * The organization's name and logo only — everyone signed into the tenant
   * needs this to render their own portal's shell (sidebar branding), not
   * just admins, so it's deliberately narrower than `getOrganizationProfile`
   * (no contact/registration details) and exposed on a route with no
   * `@RequirePermissions`/`@RequireModule` gate.
   */
  async getOrganizationBranding(tenantId: string) {
    const tenant = await this.tenantService.getTenantById(tenantId);

    return {
      organizationName: tenant.organizationName || tenant.name,
      logoUrl: tenant.logoUrl,
    };
  }

  async updateOrganizationProfile(tenantId: string, dto: UpdateOrganizationProfileDto) {
    const tenant = await this.tenantService.getTenantById(tenantId);
    await tenant.update(dto);
    return this.getOrganizationProfile(tenantId);
  }

  /**
   * The signed-in admin's own photo. This lives on `Tenant.adminAvatarUrl`
   * rather than on `AuthCredential` — it's the same field the SuperAdmin's
   * Organizations list already reads for the "Primary Admin" avatar
   * (`PlatformOrganizationsService.toRow`), so updating it here keeps both
   * views in sync instead of introducing a second, divergent avatar.
   */
  async getAdminAvatar(tenantId: string) {
    const tenant = await this.tenantService.getTenantById(tenantId);
    return { avatarUrl: tenant.adminAvatarUrl || null };
  }

  async updateAdminAvatar(tenantId: string, avatarUrl: string) {
    const tenant = await this.tenantService.getTenantById(tenantId);
    await tenant.update({ adminAvatarUrl: avatarUrl });
    return { avatarUrl: tenant.adminAvatarUrl };
  }

  // ==========================================
  // DEPARTMENTS CRUD
  // ==========================================

  private async validateParentDepartment(
    departmentModel: typeof Department,
    tenantId: string,
    departmentId: string | null,
    parentDepartmentId: string,
  ) {
    if (departmentId && departmentId === parentDepartmentId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'A department cannot be its own parent.',
      );
    }

    const parent = await departmentModel.findOne({
      where: { id: parentDepartmentId, tenantId },
    });

    if (!parent) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Parent department '${parentDepartmentId}' was not found in this organization.`,
      );
    }

    if (departmentId) {
      let currentParentId: string | null = parent.parentDepartmentId;
      while (currentParentId) {
        if (currentParentId === departmentId) {
          throw new TenantException(
            TenantErrorCode.INVALID_TENANT_CONTEXT,
            'Circular department parent hierarchy detected.',
          );
        }
        const ancestor = await departmentModel.findOne({
          where: { id: currentParentId, tenantId },
        });
        currentParentId = ancestor ? ancestor.parentDepartmentId : null;
      }
    }
  }

  async getDepartments(tenantId: string) {
    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    return departmentModel.findAll({ where: { tenantId } });
  }

  async createDepartment(tenantId: string, dto: CreateDepartmentDto) {
    await this.tenantService.getTenantById(tenantId);
    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    const existing = await departmentModel.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Department '${dto.name}' already exists in this organization.`,
      );
    }

    if (dto.parentDepartmentId) {
      await this.validateParentDepartment(departmentModel, tenantId, null, dto.parentDepartmentId);
    }

    return departmentModel.create({ ...dto, tenantId });
  }

  async updateDepartment(tenantId: string, departmentId: string, dto: UpdateDepartmentDto) {
    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    const dept = await departmentModel.findOne({
      where: { id: departmentId, tenantId },
    });
    if (!dept) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Department not found.');
    }

    if (dto.parentDepartmentId) {
      await this.validateParentDepartment(departmentModel, tenantId, departmentId, dto.parentDepartmentId);
    }

    return dept.update(dto);
  }

  async deleteDepartment(tenantId: string, departmentId: string) {
    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    const dept = await departmentModel.findOne({
      where: { id: departmentId, tenantId },
    });
    if (!dept) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Department not found.');
    }
    await dept.destroy();
    return { message: `Department '${dept.name}' deleted successfully.` };
  }

  // ==========================================
  // DESIGNATIONS CRUD
  // ==========================================

  async getDesignations(tenantId: string) {
    const designationModel = await this.modelProvider.getDesignationModel(tenantId);
    const departmentModel = await this.modelProvider.getDepartmentModel(tenantId);
    return designationModel.findAll({
      where: { tenantId },
      include: [departmentModel],
    });
  }

  /**
   * `code` (level codes like "L2", "L4") is only unique within a department
   * — the same level code is expected to repeat across departments — while
   * `title` stays unique across the whole organization. Mirrors the DB's
   * `unique_designation_code_per_department` index so a duplicate is caught
   * here with a clear message instead of surfacing as a raw constraint error.
   */
  private async assertDesignationCodeAvailable(
    designationModel: typeof Designation,
    tenantId: string,
    code: string | undefined,
    departmentId: string | undefined,
    excludeId?: string,
  ): Promise<void> {
    if (!code) return;
    const existingCode = await designationModel.findOne({
      where: { tenantId, departmentId: departmentId ?? null, code },
    });
    if (existingCode && existingCode.id !== excludeId) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Designation code '${code}' already exists in this department.`,
      );
    }
  }

  async createDesignation(tenantId: string, dto: CreateDesignationDto) {
    await this.tenantService.getTenantById(tenantId);
    const designationModel = await this.modelProvider.getDesignationModel(tenantId);
    const existing = await designationModel.findOne({
      where: { tenantId, title: dto.title },
    });
    if (existing) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Designation '${dto.title}' already exists in this organization.`,
      );
    }
    await this.assertDesignationCodeAvailable(
      designationModel,
      tenantId,
      dto.code,
      dto.departmentId,
    );
    return designationModel.create({ ...dto, tenantId });
  }

  async updateDesignation(tenantId: string, designationId: string, dto: UpdateDesignationDto) {
    const designationModel = await this.modelProvider.getDesignationModel(tenantId);
    const desig = await designationModel.findOne({
      where: { id: designationId, tenantId },
    });
    if (!desig) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Designation not found.');
    }
    await this.assertDesignationCodeAvailable(
      designationModel,
      tenantId,
      dto.code ?? desig.code,
      dto.departmentId ?? desig.departmentId,
      designationId,
    );
    return desig.update(dto);
  }

  async deleteDesignation(tenantId: string, designationId: string) {
    const designationModel = await this.modelProvider.getDesignationModel(tenantId);
    const desig = await designationModel.findOne({
      where: { id: designationId, tenantId },
    });
    if (!desig) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Designation not found.');
    }
    await desig.destroy();
    return { message: `Designation '${desig.title}' deleted successfully.` };
  }

  // ==========================================
  // WORKING HOURS & SHIFTS
  // ==========================================

  async getWorkingHours(tenantId: string) {
    const workingHoursModel = await this.modelProvider.getWorkingHoursModel(tenantId);
    return workingHoursModel.findOne({ where: { tenantId } });
  }

  async updateWorkingHours(tenantId: string, dto: UpdateWorkingHoursDto) {
    await this.tenantService.getTenantById(tenantId);
    const workingHoursModel = await this.modelProvider.getWorkingHoursModel(tenantId);
    const existing = await workingHoursModel.findOne({ where: { tenantId } });
    if (existing) {
      return existing.update({
        ...dto,
        workingDays: dto.workingDays || existing.workingDays,
      });
    }
    return workingHoursModel.create({
      ...dto,
      tenantId,
      name: dto.name || 'Standard Office Shift',
      workingDays: dto.workingDays || ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    });
  }

  // ==========================================
  // LEAVE POLICIES CRUD
  // ==========================================

  async getLeavePolicies(tenantId: string) {
    const leavePolicyModel = await this.modelProvider.getLeavePolicyModel(tenantId);
    return leavePolicyModel.findAll({ where: { tenantId } });
  }

  async createLeavePolicy(tenantId: string, dto: CreateLeavePolicyDto) {
    await this.tenantService.getTenantById(tenantId);
    const leavePolicyModel = await this.modelProvider.getLeavePolicyModel(tenantId);
    const existing = await leavePolicyModel.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Leave Policy '${dto.name}' already exists in this organization.`,
      );
    }
    return leavePolicyModel.create({ ...dto, tenantId });
  }

  async updateLeavePolicy(tenantId: string, policyId: string, dto: UpdateLeavePolicyDto) {
    const leavePolicyModel = await this.modelProvider.getLeavePolicyModel(tenantId);
    const policy = await leavePolicyModel.findOne({
      where: { id: policyId, tenantId },
    });
    if (!policy) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Leave Policy not found.');
    }
    return policy.update(dto);
  }

  async deleteLeavePolicy(tenantId: string, policyId: string) {
    const leavePolicyModel = await this.modelProvider.getLeavePolicyModel(tenantId);
    const policy = await leavePolicyModel.findOne({
      where: { id: policyId, tenantId },
    });
    if (!policy) {
      throw new TenantException(TenantErrorCode.INVALID_TENANT_CONTEXT, 'Leave Policy not found.');
    }

    // Leave requests carry a real FK to this row, so destroying a policy that
    // is still in use would fail on a constraint violation deep in Sequelize.
    // Refuse it here with an answer the admin can act on, and point them at
    // deactivating instead — which keeps the history readable while stopping
    // the type appearing on new requests.
    const leaveRequestModel = await this.modelProvider.getLeaveRequestModel(tenantId);
    const inUse = await leaveRequestModel.count({
      where: { tenantId, leavePolicyId: policyId },
    });
    if (inUse > 0) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Leave Policy '${policy.name}' is used by ${inUse} leave request(s) and cannot be deleted. Deactivate it instead.`,
        HttpStatus.CONFLICT,
      );
    }

    await policy.destroy();
    return { message: `Leave Policy '${policy.name}' deleted successfully.` };
  }

  // ==========================================
  // ATTENDANCE POLICY
  // ==========================================

  async getAttendancePolicy(tenantId: string) {
    const attendancePolicyModel = await this.modelProvider.getAttendancePolicyModel(tenantId);
    return attendancePolicyModel.findOne({ where: { tenantId } });
  }

  async updateAttendancePolicy(tenantId: string, dto: UpdateAttendancePolicyDto) {
    await this.tenantService.getTenantById(tenantId);
    const attendancePolicyModel = await this.modelProvider.getAttendancePolicyModel(tenantId);
    const existing = await attendancePolicyModel.findOne({ where: { tenantId } });

    // Checked against what's already saved, so changing one of the two
    // thresholds alone can't leave them out of order.
    const halfDay = dto.halfDayHours ?? (existing?.halfDayHours != null ? Number(existing.halfDayHours) : null);
    const fullDay = dto.fullDayHours ?? (existing?.fullDayHours != null ? Number(existing.fullDayHours) : null);
    if (halfDay != null && fullDay != null && halfDay >= fullDay) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        'The half-day threshold must be lower than the full-day threshold.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.allowedIpRanges) {
      dto.allowedIpRanges = [...new Set(dto.allowedIpRanges.map((ip) => ip.trim()).filter(Boolean))];
    }
    if (existing) {
      return existing.update(dto);
    }
    return attendancePolicyModel.create({ ...dto, tenantId });
  }

  // ==========================================
  // SETUP COMPLETION (LIFECYCLE TRANSITION)
  // ==========================================

  /**
   * Finalize Setup Wizard & Activate Organization Tenant
   */
  async completeSetup(tenantId: string) {
    const tenant = await this.tenantService.getTenantById(tenantId);

    // Idempotent Check: If already COMPLETED and ACTIVE
    if (
      tenant.setupStatus === TenantSetupStatus.COMPLETED &&
      tenant.status === TenantStatus.ACTIVE
    ) {
      return {
        message: 'Organization setup is already completed and organization is ACTIVE.',
        tenantId: tenant.id,
        status: TenantStatus.ACTIVE,
        setupStatus: TenantSetupStatus.COMPLETED,
        provisioningStatus: TenantProvisioningStatus.READY,
      };
    }

    const progress = await this.getSetupProgress(tenantId);

    if (!progress.isComplete) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Cannot complete organization setup. Pending modules: ${progress.missingModules.join(', ')}. Please configure all required sections first.`,
      );
    }

    // Transition tenant to ACTIVE status
    await tenant.update({
      status: TenantStatus.ACTIVE,
      setupStatus: TenantSetupStatus.COMPLETED,
      provisioningStatus: TenantProvisioningStatus.READY,
    });

    this.logger.log(`Organization ${tenant.id} (${tenant.name}) setup COMPLETED. Tenant status set to ACTIVE.`);
    this.platformNotifier?.account(
      `${tenant.organizationName || tenant.name} is live`,
      'Its admin finished the setup wizard; the organization is now active.',
    );

    return {
      message: 'Organization setup completed successfully. Organization is now ACTIVE.',
      tenantId: tenant.id,
      organizationName: tenant.organizationName || tenant.name,
      status: TenantStatus.ACTIVE,
      setupStatus: TenantSetupStatus.COMPLETED,
      provisioningStatus: TenantProvisioningStatus.READY,
    };
  }
}
