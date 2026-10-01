import { Injectable } from '@nestjs/common';
import {
  CreateOrganizationOnboardingDto,
  HRMSModuleKey,
  TenantException,
  TenantErrorCode,
} from '@app/common';
import { TenantService } from './tenant.service';

export interface OnboardingReviewSummary {
  isValid: boolean;
  organization: {
    organizationName: string;
    domain?: string;
    slug: string;
  };
  initialAdmin: {
    firstName: string;
    lastName: string;
    workEmail: string;
    phone?: string;
    industry?: string;
    averageUsers?: string;
    jobTitle?: string;
    initialDepartment?: string;
    sendInvitation: boolean;
    customInvitationMessage?: string;
  };
  modules: {
    totalConfigured: number;
    enabledModules: string[];
    disabledModules: string[];
    moduleDetails: Array<{
      moduleKey: string;
      enabled: boolean;
      allowedActions: string[];
    }>;
  };
  scope: {
    departments: string[];
    locations: string[];
    teams: string[];
    designations: string[];
  };
  warnings: string[];
}

@Injectable()
export class OrganizationOnboardingValidatorService {
  constructor(private tenantService: TenantService) {}

  /**
   * Validate full onboarding payload
   */
  async validateOnboardingPayload(dto: CreateOrganizationOnboardingDto): Promise<{ isValid: boolean; messages: string[] }> {
    const messages: string[] = [];

    // Step 1 Validation
    if (!dto.organizationName || dto.organizationName.trim().length === 0) {
      messages.push('Organization Name is required.');
    }

    if (!dto.adminDetails) {
      messages.push('Initial Admin Details are required (Step 1).');
    } else {
      if (!dto.adminDetails.workEmail) {
        messages.push('Admin Work Email is required.');
      }
      if (!dto.adminDetails.firstName) {
        messages.push('Admin First Name is required.');
      }
      if (!dto.adminDetails.lastName) {
        messages.push('Admin Last Name is required.');
      }
    }

    // Check duplicate organization domain/slug
    if (dto.organizationName) {
      const slug = (dto.domain || dto.organizationName)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-');

      const existing = await this.tenantService.getTenantByDomainOrSlug(slug);
      if (existing) {
        throw new TenantException(
          TenantErrorCode.INVALID_TENANT_CONTEXT,
          `An organization with domain/slug '${slug}' already exists.`,
        );
      }
    }

    // Step 2 Validation (Modules)
    if (dto.modules && dto.modules.length > 0) {
      const validModules = Object.values(HRMSModuleKey) as string[];
      for (const mod of dto.modules) {
        if (!validModules.includes(mod.moduleKey.toLowerCase())) {
          messages.push(`Invalid module key '${mod.moduleKey}' provided.`);
        }
      }
    }

    return {
      isValid: messages.length === 0,
      messages,
    };
  }

  /**
   * Generate Step 4 Review & Confirm summary
   */
  async generateReviewSummary(dto: CreateOrganizationOnboardingDto): Promise<OnboardingReviewSummary> {
    const validation = await this.validateOnboardingPayload(dto);
    if (!validation.isValid) {
      throw new TenantException(
        TenantErrorCode.INVALID_TENANT_CONTEXT,
        `Validation failed for organization onboarding: ${validation.messages.join('; ')}`,
      );
    }

    const slug = (dto.domain || dto.organizationName)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-');

    const modules = dto.modules || [];
    const enabledModules = modules.filter((m) => m.enabled).map((m) => m.moduleKey);
    const disabledModules = modules.filter((m) => !m.enabled).map((m) => m.moduleKey);

    const warnings: string[] = [];
    if (enabledModules.length === 0) {
      warnings.push('No modules were explicitly enabled. Default HRMS modules will be enabled.');
    }

    return {
      isValid: true,
      organization: {
        organizationName: dto.organizationName,
        domain: dto.domain,
        slug,
      },
      initialAdmin: {
        firstName: dto.adminDetails.firstName,
        lastName: dto.adminDetails.lastName,
        workEmail: dto.adminDetails.workEmail,
        phone: dto.adminDetails.phone,
        industry: dto.adminDetails.industry,
        averageUsers: dto.adminDetails.averageUsers,
        jobTitle: dto.adminDetails.jobTitle,
        initialDepartment: dto.adminDetails.initialDepartment,
        sendInvitation: dto.adminDetails.sendInvitation !== false,
        customInvitationMessage: dto.adminDetails.customInvitationMessage,
      },
      modules: {
        totalConfigured: modules.length,
        enabledModules,
        disabledModules,
        moduleDetails: modules.map((m) => ({
          moduleKey: m.moduleKey,
          enabled: m.enabled,
          allowedActions: m.allowedActions || ['all'],
        })),
      },
      scope: {
        departments: dto.scope?.departments || [],
        locations: dto.scope?.locations || [],
        teams: dto.scope?.teams || [],
        designations: dto.scope?.designations || [],
      },
      warnings,
    };
  }

  // ==========================================
  // 3-STEP INITIAL ONBOARDING METHODS
  // ==========================================

  /**
   * Returns metadata for Step 1 dropdowns (Countries, Industries, Company Sizes)
   */
  getInitialMetadata() {
    return {
      countries: [
        { code: 'US', name: 'United States', dialCode: '+1' },
        { code: 'GB', name: 'United Kingdom', dialCode: '+44' },
        { code: 'PK', name: 'Pakistan', dialCode: '+92' },
        { code: 'AE', name: 'United Arab Emirates', dialCode: '+971' },
        { code: 'SA', name: 'Saudi Arabia', dialCode: '+966' },
        { code: 'CA', name: 'Canada', dialCode: '+1' },
        { code: 'AU', name: 'Australia', dialCode: '+61' },
        { code: 'DE', name: 'Germany', dialCode: '+49' },
        { code: 'FR', name: 'France', dialCode: '+33' },
        { code: 'IN', name: 'India', dialCode: '+91' },
        { code: 'SG', name: 'Singapore', dialCode: '+65' },
      ],
      industries: [
        'Technology & IT',
        'Healthcare & Pharmaceuticals',
        'Financial Services & Banking',
        'Manufacturing & Production',
        'Retail & E-commerce',
        'Education & E-learning',
        'Telecommunications',
        'Professional & Legal Services',
        'Real Estate & Construction',
        'Hospitality & Tourism',
        'Logistics & Supply Chain',
        'Other',
      ],
      companySizes: [
        '1-10 employees',
        '11-50 employees',
        '51-200 employees',
        '201-500 employees',
        '501-1000 employees',
        '1000+ employees',
      ],
    };
  }

  /**
   * Real-time Step Validator (Step 1 or Step 2)
   */
  async validateInitialStep(step: number, data: any): Promise<{ isValid: boolean; step: number; errors: string[] }> {
    const errors: string[] = [];

    if (Number(step) === 1) {
      const orgName = data?.organizationName || data?.organizationInfo?.organizationName;
      const businessEmail = data?.businessEmail || data?.organizationInfo?.businessEmail;

      if (!orgName || !orgName.trim()) {
        errors.push('Organization Name is required.');
      }

      if (!businessEmail || !businessEmail.trim()) {
        errors.push('Business Email is required.');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail.trim())) {
        errors.push('Business Email format is invalid.');
      }

      if (orgName && orgName.trim()) {
        const slug = (data?.slug || data?.domain || orgName)
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-');

        const existing = await this.tenantService.getTenantByDomainOrSlug(slug);
        if (existing) {
          errors.push(`An organization with name/slug '${slug}' already exists.`);
        }
      }
    } else if (Number(step) === 2) {
      const adminName = data?.adminName || data?.adminInfo?.adminName;
      const adminEmail = data?.adminEmail || data?.adminInfo?.adminEmail;

      if (!adminName || !adminName.trim()) {
        errors.push('Admin Name is required.');
      }

      if (!adminEmail || !adminEmail.trim()) {
        errors.push('Admin Email is required.');
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim())) {
        errors.push('Admin Email format is invalid.');
      }
    }

    return {
      isValid: errors.length === 0,
      step: Number(step),
      errors,
    };
  }

  /**
   * Generates Step 3 Review & Confirm Summary for display
   */
  async generateInitialReview(dto: any) {
    const org = dto?.organizationInfo || dto;
    const admin = dto?.adminInfo || dto;

    const orgName = org?.organizationName || '';
    const businessEmail = org?.businessEmail || '';
    const adminName = admin?.adminName || '';
    const adminEmail = admin?.adminEmail || '';

    const validationStep1 = await this.validateInitialStep(1, org);
    const validationStep2 = await this.validateInitialStep(2, admin);

    const allErrors = [...validationStep1.errors, ...validationStep2.errors];

    return {
      isValid: allErrors.length === 0,
      errors: allErrors,
      organizationInfo: {
        organizationName: orgName,
        legalName: org?.legalName || orgName,
        businessEmail: businessEmail,
        phone: org?.phone || null,
        country: org?.country || null,
        industry: org?.industry || null,
        companySize: org?.companySize || null,
      },
      adminInfo: {
        adminName: adminName,
        adminEmail: adminEmail,
        adminPhone: admin?.adminPhone || null,
        profilePhoto: admin?.profilePhoto || null,
        sendInvitation: admin?.sendInvitation !== false,
        customMessage: admin?.customMessage || null,
      },
      status: allErrors.length === 0 ? 'Ready for Creation' : 'Validation Issues',
    };
  }
}
