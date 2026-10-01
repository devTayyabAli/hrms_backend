import {
  LeaveAccrualType,
  LeaveEligibility,
  PolicyType,
  PolicyStatus,
} from '@app/common';

export interface TemplateDepartment {
  name: string;
  code: string;
  description?: string;
}

export interface TemplateDesignation {
  title: string;
  /** Carries the level (e.g. "L4") — the same convention the Designations screen already uses. */
  code: string;
  /** Matches a department's `code` above — resolved to a real `departmentId` when the template is applied. */
  departmentCode: string;
}

export interface TemplateLeavePolicy {
  name: string;
  description?: string;
  annualAllocation: number;
  isPaid: boolean;
  accrualType: LeaveAccrualType;
  carryForwardDays: number | null;
  eligibility: LeaveEligibility;
}

export interface TemplatePolicy {
  name: string;
  description?: string;
  policyType: PolicyType;
  configuration: Record<string, unknown>;
  /** Only ACTIVE/DRAFT are meaningful here — a template never seeds an already-INACTIVE/ARCHIVED policy. */
  status: PolicyStatus.ACTIVE | PolicyStatus.DRAFT;
}

export interface IndustryTemplate {
  departments: TemplateDepartment[];
  designations: TemplateDesignation[];
  leavePolicies: TemplateLeavePolicy[];
  policies: TemplatePolicy[];
}

/** Default fallback template for General Business, Professional Services, and unlisted industries. */
const DEFAULT_BUSINESS_TEMPLATE: IndustryTemplate = {
  departments: [
    {
      name: 'Operations',
      code: 'OPS',
      description: 'Operations management, process excellence, and administration',
    },
    {
      name: 'Human Resources',
      code: 'HR',
      description: 'People operations, recruiting, culture, and employee relations',
    },
    {
      name: 'Finance & Accounts',
      code: 'FIN',
      description: 'Financial planning, accounting, tax, and payroll support',
    },
    {
      name: 'Sales & Business Development',
      code: 'SAL',
      description: 'New business acquisition, customer partnerships, and sales growth',
    },
    {
      name: 'Marketing',
      code: 'MKT',
      description: 'Brand, content, communications, and digital marketing',
    },
    {
      name: 'Information Technology',
      code: 'IT',
      description: 'IT systems, infrastructure, end-user support, and cybersecurity',
    },
    {
      name: 'Administration & Facilities',
      code: 'ADM',
      description: 'Office management, facilities, vendors, and supplies',
    },
  ],
  designations: [
    { title: 'Operations Lead', code: 'L3', departmentCode: 'OPS' },
    { title: 'Operations Specialist', code: 'L2', departmentCode: 'OPS' },
    { title: 'HR Business Partner', code: 'L3', departmentCode: 'HR' },
    { title: 'HR Specialist', code: 'L2', departmentCode: 'HR' },
    { title: 'Finance Specialist', code: 'L2', departmentCode: 'FIN' },
    { title: 'Senior Accountant', code: 'L3', departmentCode: 'FIN' },
    { title: 'Sales Executive', code: 'L2', departmentCode: 'SAL' },
    { title: 'Senior Sales Manager', code: 'L4', departmentCode: 'SAL' },
    { title: 'Marketing Specialist', code: 'L2', departmentCode: 'MKT' },
    { title: 'IT Support Engineer', code: 'L2', departmentCode: 'IT' },
    { title: 'Administrative Coordinator', code: 'L2', departmentCode: 'ADM' },
  ],
  leavePolicies: [
    {
      name: 'Annual Leave',
      description: 'Standard yearly vacation allowance',
      annualAllocation: 21,
      isPaid: true,
      accrualType: LeaveAccrualType.MONTHLY,
      carryForwardDays: 5,
      eligibility: LeaveEligibility.ALL_EMPLOYEES,
    },
    {
      name: 'Sick Leave',
      description: 'For illness or medical appointments',
      annualAllocation: 12,
      isPaid: true,
      accrualType: LeaveAccrualType.ANNUAL_GRANT,
      carryForwardDays: null,
      eligibility: LeaveEligibility.ALL_EMPLOYEES,
    },
    {
      name: 'Casual Leave',
      description: 'Short personal leave for everyday needs',
      annualAllocation: 8,
      isPaid: true,
      accrualType: LeaveAccrualType.ANNUAL_GRANT,
      carryForwardDays: null,
      eligibility: LeaveEligibility.ALL_EMPLOYEES,
    },
    {
      name: 'Maternity Leave',
      description: 'Paid leave around childbirth',
      annualAllocation: 180,
      isPaid: true,
      accrualType: LeaveAccrualType.EVENT_BASED,
      carryForwardDays: null,
      eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
    },
    {
      name: 'Paternity Leave',
      description: 'Paid leave for new fathers',
      annualAllocation: 15,
      isPaid: true,
      accrualType: LeaveAccrualType.EVENT_BASED,
      carryForwardDays: null,
      eligibility: LeaveEligibility.MALE_EMPLOYEES,
    },
  ],
  policies: [
    {
      name: 'Hybrid Work Policy',
      description: 'Guidelines for remote work eligibility and office attendance',
      policyType: PolicyType.REMOTE_WORK,
      configuration: {
        allowedDaysPerWeek: 2,
        requiresApproval: true,
        allowFullRemote: false,
      },
      status: PolicyStatus.ACTIVE,
    },
    {
      name: 'Standard Working Hours',
      description: 'Core office hours and working schedule',
      policyType: PolicyType.WORKING_HOURS,
      configuration: {
        startTime: '09:00',
        endTime: '18:00',
        workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
        isFlexible: true,
      },
      status: PolicyStatus.ACTIVE,
    },
    {
      name: 'Overtime Compensation Policy',
      description: 'Rules for overtime approval, tracking, and compensation',
      policyType: PolicyType.OVERTIME,
      configuration: {
        enabled: true,
        multiplier: 1.5,
        requiresApproval: true,
        maximumHoursPerWeek: 10,
      },
      status: PolicyStatus.ACTIVE,
    },
    {
      name: 'Leave Encashment Policy',
      description: 'Annual leave balance encashment at financial year end',
      policyType: PolicyType.LEAVE,
      configuration: {
        annualAllocation: 21,
        isPaid: true,
        carryForward: true,
        maximumCarryForward: 5,
      },
      status: PolicyStatus.ACTIVE,
    },
    {
      name: 'Code of Conduct & Workplace Ethics',
      description: 'Standards of professionalism, integrity, and anti-harassment',
      policyType: PolicyType.GENERAL,
      configuration: {
        mandatory: true,
        appliesTo: 'ALL_EMPLOYEES',
        reviewCycleMonths: 12,
      },
      status: PolicyStatus.ACTIVE,
    },
  ],
};

/**
 * Standard starting-point data per industry, offered during onboarding and
 * later from Organization Settings.
 */
export const INDUSTRY_TEMPLATES: Record<string, IndustryTemplate> = {
  'Technology & IT': {
    departments: [
      {
        name: 'Engineering',
        code: 'ENG',
        description: 'Product engineering and software development',
      },
      {
        name: 'Product Management',
        code: 'PRD',
        description: 'Product strategy, roadmap and discovery',
      },
      { name: 'Design', code: 'DES', description: 'Product and UX/UI design' },
      {
        name: 'Sales',
        code: 'SAL',
        description: 'New business and account management',
      },
      {
        name: 'Finance & Accounts',
        code: 'FIN',
        description: 'Financial planning, accounting and payroll support',
      },
      {
        name: 'Human Resources',
        code: 'HR',
        description: 'Recruitment, people operations and culture',
      },
      {
        name: 'Marketing',
        code: 'MKT',
        description: 'Brand, growth and demand generation',
      },
      {
        name: 'Operations',
        code: 'OPS',
        description: 'Business operations and internal tooling',
      },
    ],
    designations: [
      { title: 'Software Engineer', code: 'L2', departmentCode: 'ENG' },
      { title: 'Senior Software Engineer', code: 'L3', departmentCode: 'ENG' },
      { title: 'Staff Engineer', code: 'L4', departmentCode: 'ENG' },
      { title: 'Engineering Manager', code: 'L5', departmentCode: 'ENG' },
      { title: 'Product Manager', code: 'L4', departmentCode: 'PRD' },
      { title: 'Lead UX Designer', code: 'L3', departmentCode: 'DES' },
      { title: 'Sales Executive', code: 'L2', departmentCode: 'SAL' },
      { title: 'Senior Sales Manager', code: 'L4', departmentCode: 'SAL' },
      { title: 'HR Business Partner', code: 'L3', departmentCode: 'HR' },
      { title: 'Finance Analyst', code: 'L2', departmentCode: 'FIN' },
    ],
    leavePolicies: [
      {
        name: 'Annual Leave',
        description: 'Standard yearly vacation allowance',
        annualAllocation: 21,
        isPaid: true,
        accrualType: LeaveAccrualType.MONTHLY,
        carryForwardDays: 5,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Sick Leave',
        description: 'For illness or medical appointments',
        annualAllocation: 12,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Casual Leave',
        description: 'Short personal leave for everyday needs',
        annualAllocation: 8,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Maternity Leave',
        description: 'Paid leave around childbirth',
        annualAllocation: 180,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
      },
      {
        name: 'Paternity Leave',
        description: 'Paid leave for new fathers',
        annualAllocation: 15,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.MALE_EMPLOYEES,
      },
    ],
    policies: [
      {
        name: 'Work From Home Policy',
        description:
          'Guidelines for remote work eligibility, schedule and conduct',
        policyType: PolicyType.REMOTE_WORK,
        configuration: {
          allowedDaysPerWeek: 2,
          requiresApproval: true,
          allowFullRemote: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Overtime Compensation',
        description: 'Rules for overtime approval, calculation and payment',
        policyType: PolicyType.OVERTIME,
        configuration: {
          enabled: true,
          multiplier: 1.5,
          requiresApproval: true,
          maximumHoursPerWeek: 10,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Leave Encashment Policy',
        description: 'Annual leave balance encashment at financial year end',
        policyType: PolicyType.LEAVE,
        configuration: {
          annualAllocation: 21,
          isPaid: true,
          carryForward: true,
          maximumCarryForward: 5,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Flexible Hours Policy',
        description:
          'Core hours definition and flexibility window for employees',
        policyType: PolicyType.WORKING_HOURS,
        configuration: {
          startTime: '09:00',
          endTime: '18:00',
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
          isFlexible: true,
        },
        status: PolicyStatus.DRAFT,
      },
    ],
  },

  'Healthcare & Pharmaceuticals': {
    departments: [
      {
        name: 'Clinical Operations',
        code: 'CLN',
        description: 'Day-to-day clinical service delivery',
      },
      {
        name: 'Nursing',
        code: 'NUR',
        description: 'Nursing staff and patient care coordination',
      },
      {
        name: 'Pharmacy',
        code: 'PHM',
        description: 'Dispensing, inventory and pharmaceutical compliance',
      },
      {
        name: 'Patient Care & Support',
        code: 'PCS',
        description: 'Front-desk, admissions and patient support services',
      },
      {
        name: 'Regulatory & Compliance',
        code: 'REG',
        description: 'Regulatory affairs and quality compliance',
      },
      {
        name: 'Administration',
        code: 'ADM',
        description: 'Facility and administrative operations',
      },
      {
        name: 'Human Resources',
        code: 'HR',
        description: 'Recruitment, people operations and credentialing',
      },
      {
        name: 'Finance & Accounts',
        code: 'FIN',
        description: 'Billing, accounting and financial planning',
      },
    ],
    designations: [
      { title: 'Staff Nurse', code: 'L2', departmentCode: 'NUR' },
      { title: 'Senior Staff Nurse', code: 'L3', departmentCode: 'NUR' },
      { title: 'Nursing Supervisor', code: 'L4', departmentCode: 'NUR' },
      { title: 'Clinical Officer', code: 'L3', departmentCode: 'CLN' },
      { title: 'Medical Officer', code: 'L4', departmentCode: 'CLN' },
      { title: 'Pharmacist', code: 'L3', departmentCode: 'PHM' },
      { title: 'Pharmacy Technician', code: 'L2', departmentCode: 'PHM' },
      { title: 'Patient Care Coordinator', code: 'L2', departmentCode: 'PCS' },
      { title: 'Compliance Officer', code: 'L3', departmentCode: 'REG' },
      { title: 'HR Business Partner', code: 'L3', departmentCode: 'HR' },
    ],
    leavePolicies: [
      {
        name: 'Annual Leave',
        description: 'Standard yearly vacation allowance',
        annualAllocation: 21,
        isPaid: true,
        accrualType: LeaveAccrualType.MONTHLY,
        carryForwardDays: 5,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Sick Leave',
        description: 'For illness or medical appointments',
        annualAllocation: 14,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Casual Leave',
        description: 'Short personal leave for everyday needs',
        annualAllocation: 8,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Maternity Leave',
        description: 'Paid leave around childbirth',
        annualAllocation: 180,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
      },
      {
        name: 'Paternity Leave',
        description: 'Paid leave for new fathers',
        annualAllocation: 15,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.MALE_EMPLOYEES,
      },
      {
        name: 'Compensatory Off',
        description: 'Time off in lieu of hours worked on a rostered rest day',
        annualAllocation: 6,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
    ],
    policies: [
      {
        name: 'Night Shift Allowance',
        description: 'Additional compensation for scheduled night shifts',
        policyType: PolicyType.OVERTIME,
        configuration: {
          enabled: true,
          multiplier: 1.25,
          requiresApproval: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Clinical Duty & Handover Attendance Policy',
        description: 'Protocols for shift punctuality, clinical duty logs, and patient handover',
        policyType: PolicyType.ATTENDANCE,
        configuration: {
          trackingMode: 'BIOMETRIC',
          gracePeriodMinutes: 15,
          requireBiometric: true,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Patient Confidentiality Policy',
        description: 'Handling of patient health information and records',
        policyType: PolicyType.GENERAL,
        configuration: {
          mandatory: true,
          appliesTo: 'ALL_EMPLOYEES',
          acknowledgementRequired: true,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Leave Encashment Policy',
        description: 'Annual leave balance encashment at financial year end',
        policyType: PolicyType.LEAVE,
        configuration: {
          annualAllocation: 21,
          isPaid: true,
          carryForward: true,
          maximumCarryForward: 5,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Shift Scheduling Policy',
        description:
          'Core shift structure and flexibility for non-clinical staff',
        policyType: PolicyType.WORKING_HOURS,
        configuration: {
          startTime: '08:00',
          endTime: '17:00',
          workingDays: [
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
          ],
          isFlexible: false,
        },
        status: PolicyStatus.DRAFT,
      },
    ],
  },

  'Financial Services & Banking': {
    departments: [
      {
        name: 'Investment & Wealth Management',
        code: 'INV',
        description: 'Investment advisory, portfolio management, and wealth solutions',
      },
      {
        name: 'Risk & Compliance',
        code: 'RSK',
        description: 'Risk assessment, regulatory reporting, and compliance controls',
      },
      {
        name: 'Finance & Accounts',
        code: 'FIN',
        description: 'Statutory accounting, financial planning, and audits',
      },
      {
        name: 'Operations & Settlement',
        code: 'OPS',
        description: 'Transaction processing, reconciliations, and clearing',
      },
      {
        name: 'Human Resources',
        code: 'HR',
        description: 'Talent management, certification tracking, and people ops',
      },
      {
        name: 'Information Security & IT',
        code: 'SEC',
        description: 'InfoSec, financial tech infrastructure, and access security',
      },
      {
        name: 'Client Relations & Sales',
        code: 'SAL',
        description: 'Institutional partnerships, client advisory, and sales',
      },
    ],
    designations: [
      { title: 'Financial Analyst', code: 'L2', departmentCode: 'FIN' },
      { title: 'Senior Finance Officer', code: 'L3', departmentCode: 'FIN' },
      { title: 'Investment Associate', code: 'L3', departmentCode: 'INV' },
      { title: 'Portfolio Manager', code: 'L4', departmentCode: 'INV' },
      { title: 'Compliance Analyst', code: 'L2', departmentCode: 'RSK' },
      { title: 'Risk Manager', code: 'L4', departmentCode: 'RSK' },
      { title: 'Settlement Specialist', code: 'L2', departmentCode: 'OPS' },
      { title: 'Operations Lead', code: 'L3', departmentCode: 'OPS' },
      { title: 'Security Analyst', code: 'L2', departmentCode: 'SEC' },
      { title: 'HR Business Partner', code: 'L3', departmentCode: 'HR' },
    ],
    leavePolicies: [
      {
        name: 'Annual Leave',
        description: 'Statutory annual holiday allowance',
        annualAllocation: 24,
        isPaid: true,
        accrualType: LeaveAccrualType.MONTHLY,
        carryForwardDays: 6,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Sick Leave',
        description: 'Medical and hospitalization leave',
        annualAllocation: 14,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Casual Leave',
        description: 'Personal emergency and casual leave',
        annualAllocation: 8,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Maternity Leave',
        description: 'Paid maternity leave',
        annualAllocation: 180,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
      },
      {
        name: 'Paternity Leave',
        description: 'Paid paternity leave',
        annualAllocation: 15,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.MALE_EMPLOYEES,
      },
    ],
    policies: [
      {
        name: 'Hybrid Financial Workplace Policy',
        description: 'Guidelines for compliant remote work and secure VPN access',
        policyType: PolicyType.REMOTE_WORK,
        configuration: {
          allowedDaysPerWeek: 1,
          requiresApproval: true,
          allowFullRemote: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Market Working Hours Policy',
        description: 'Working hours aligned with financial market operating schedules',
        policyType: PolicyType.WORKING_HOURS,
        configuration: {
          startTime: '08:30',
          endTime: '17:30',
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
          isFlexible: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Financial Closing Overtime',
        description: 'Overtime authorization during monthly, quarterly, and annual closing',
        policyType: PolicyType.OVERTIME,
        configuration: {
          enabled: true,
          multiplier: 1.5,
          requiresApproval: true,
          maximumHoursPerWeek: 12,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Leave Encashment Policy',
        description: 'Financial year-end leave encashment guidelines',
        policyType: PolicyType.LEAVE,
        configuration: {
          annualAllocation: 24,
          isPaid: true,
          carryForward: true,
          maximumCarryForward: 6,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Anti-Money Laundering & Ethics Policy',
        description: 'Regulatory compliance, conflict of interest, and market ethics',
        policyType: PolicyType.GENERAL,
        configuration: {
          mandatory: true,
          appliesTo: 'ALL_EMPLOYEES',
          acknowledgementRequired: true,
        },
        status: PolicyStatus.ACTIVE,
      },
    ],
  },

  'Manufacturing & Production': {
    departments: [
      {
        name: 'Production & Assembly',
        code: 'PRD',
        description: 'Plant operations, manufacturing lines, and assembly',
      },
      {
        name: 'Quality Assurance & QC',
        code: 'QAC',
        description: 'Material testing, quality compliance, and inspection',
      },
      {
        name: 'Plant Maintenance',
        code: 'MNT',
        description: 'Equipment servicing, machine maintenance, and safety',
      },
      {
        name: 'Supply Chain & Logistics',
        code: 'SCM',
        description: 'Procurement, vendor logistics, and inventory dispatch',
      },
      {
        name: 'Health & Safety (HSE)',
        code: 'HSE',
        description: 'Occupational safety, environmental standards, and compliance',
      },
      {
        name: 'Human Resources',
        code: 'HR',
        description: 'Workforce management, shift staffing, and employee welfare',
      },
      {
        name: 'Finance & Costing',
        code: 'FIN',
        description: 'Plant cost accounting, budgeting, and financial reporting',
      },
    ],
    designations: [
      { title: 'Assembly Technician', code: 'L1', departmentCode: 'PRD' },
      { title: 'Line Supervisor', code: 'L2', departmentCode: 'PRD' },
      { title: 'Production Manager', code: 'L4', departmentCode: 'PRD' },
      { title: 'Quality Inspector', code: 'L2', departmentCode: 'QAC' },
      { title: 'QA Engineer', code: 'L3', departmentCode: 'QAC' },
      { title: 'Maintenance Technician', code: 'L2', departmentCode: 'MNT' },
      { title: 'Safety Officer', code: 'L3', departmentCode: 'HSE' },
      { title: 'Logistics Coordinator', code: 'L2', departmentCode: 'SCM' },
      { title: 'Plant Accountant', code: 'L2', departmentCode: 'FIN' },
      { title: 'HR Officer', code: 'L2', departmentCode: 'HR' },
    ],
    leavePolicies: [
      {
        name: 'Annual / Earned Leave',
        description: 'Earned vacation allowance for plant and office staff',
        annualAllocation: 20,
        isPaid: true,
        accrualType: LeaveAccrualType.MONTHLY,
        carryForwardDays: 5,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Medical / Sick Leave',
        description: 'Health recovery and hospitalization leave',
        annualAllocation: 12,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Casual Leave',
        description: 'Short emergency leave',
        annualAllocation: 7,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Maternity Leave',
        description: 'Maternity benefit leave',
        annualAllocation: 180,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
      },
      {
        name: 'Paternity Leave',
        description: 'Paternity benefit leave',
        annualAllocation: 15,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.MALE_EMPLOYEES,
      },
      {
        name: 'Safety Compensation Off',
        description: 'Compensatory rest for emergency maintenance shifts',
        annualAllocation: 5,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
    ],
    policies: [
      {
        name: 'Plant Biometric Attendance Policy',
        description: 'Strict biometric clock-in and gate pass verification for shifts',
        policyType: PolicyType.ATTENDANCE,
        configuration: {
          trackingMode: 'BIOMETRIC',
          gracePeriodMinutes: 10,
          requireBiometric: true,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Rotational Shift Policy',
        description: 'Factory operating hours and shift rotation guidelines',
        policyType: PolicyType.WORKING_HOURS,
        configuration: {
          startTime: '08:00',
          endTime: '16:30',
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
          isFlexible: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Plant Overtime & Hazard Compensation',
        description: 'Rules and multipliers for plant overtime work',
        policyType: PolicyType.OVERTIME,
        configuration: {
          enabled: true,
          multiplier: 1.5,
          requiresApproval: true,
          maximumHoursPerWeek: 16,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Leave Encashment Policy',
        description: 'Annual leave encashment at calendar year end',
        policyType: PolicyType.LEAVE,
        configuration: {
          annualAllocation: 20,
          isPaid: true,
          carryForward: true,
          maximumCarryForward: 5,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Health & Safety Protocol',
        description: 'PPE compliance, machine lock-out, and incident reporting',
        policyType: PolicyType.GENERAL,
        configuration: {
          mandatory: true,
          appliesTo: 'ALL_EMPLOYEES',
          reviewCycleMonths: 6,
        },
        status: PolicyStatus.ACTIVE,
      },
    ],
  },

  'Retail & E-commerce': {
    departments: [
      {
        name: 'Store & Retail Operations',
        code: 'STR',
        description: 'Retail stores, floor staffing, and customer sales',
      },
      {
        name: 'E-commerce & Digital Growth',
        code: 'ECM',
        description: 'Online store, digital marketplace, and platform management',
      },
      {
        name: 'Merchandising & Inventory',
        code: 'MER',
        description: 'Category management, product purchasing, and stock planning',
      },
      {
        name: 'Customer Support',
        code: 'CSP',
        description: 'Customer inquiries, returns, and satisfaction resolution',
      },
      {
        name: 'Warehouse & Logistics',
        code: 'WHS',
        description: 'Order fulfillment, packing, and courier delivery management',
      },
      {
        name: 'Human Resources',
        code: 'HR',
        description: 'Retail staffing, payroll processing, and training',
      },
      {
        name: 'Finance & Accounts',
        code: 'FIN',
        description: 'Store revenue audit, accounting, and supplier payments',
      },
    ],
    designations: [
      { title: 'Store Associate', code: 'L1', departmentCode: 'STR' },
      { title: 'Shift Supervisor', code: 'L2', departmentCode: 'STR' },
      { title: 'Store Manager', code: 'L3', departmentCode: 'STR' },
      { title: 'Customer Support Executive', code: 'L1', departmentCode: 'CSP' },
      { title: 'Inventory Specialist', code: 'L2', departmentCode: 'MER' },
      { title: 'E-commerce Specialist', code: 'L2', departmentCode: 'ECM' },
      { title: 'Fulfillment Lead', code: 'L2', departmentCode: 'WHS' },
      { title: 'HR Officer', code: 'L2', departmentCode: 'HR' },
      { title: 'Retail Accountant', code: 'L2', departmentCode: 'FIN' },
    ],
    leavePolicies: [
      {
        name: 'Annual Leave',
        description: 'Annual vacation allowance for retail & digital staff',
        annualAllocation: 18,
        isPaid: true,
        accrualType: LeaveAccrualType.MONTHLY,
        carryForwardDays: 4,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Sick Leave',
        description: 'Medical and sick leave',
        annualAllocation: 10,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Casual Leave',
        description: 'Short personal leave',
        annualAllocation: 8,
        isPaid: true,
        accrualType: LeaveAccrualType.ANNUAL_GRANT,
        carryForwardDays: null,
        eligibility: LeaveEligibility.ALL_EMPLOYEES,
      },
      {
        name: 'Maternity Leave',
        description: 'Paid maternity leave',
        annualAllocation: 180,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.FEMALE_EMPLOYEES,
      },
      {
        name: 'Paternity Leave',
        description: 'Paid paternity leave',
        annualAllocation: 15,
        isPaid: true,
        accrualType: LeaveAccrualType.EVENT_BASED,
        carryForwardDays: null,
        eligibility: LeaveEligibility.MALE_EMPLOYEES,
      },
    ],
    policies: [
      {
        name: 'Store Attendance & Clock-in Policy',
        description: 'Punctuality and attendance verification for store shifts',
        policyType: PolicyType.ATTENDANCE,
        configuration: {
          trackingMode: 'QR_CODE',
          gracePeriodMinutes: 10,
          allowOvertime: true,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Retail Shift Schedule',
        description: 'Store operating hours and weekend roster structure',
        policyType: PolicyType.WORKING_HOURS,
        configuration: {
          startTime: '09:30',
          endTime: '18:30',
          workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
          isFlexible: false,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Peak Season Overtime Policy',
        description: 'Overtime payment guidelines during festive and discount events',
        policyType: PolicyType.OVERTIME,
        configuration: {
          enabled: true,
          multiplier: 1.5,
          requiresApproval: true,
          maximumHoursPerWeek: 12,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Leave Encashment Policy',
        description: 'Year-end leave encashment guidelines',
        policyType: PolicyType.LEAVE,
        configuration: {
          annualAllocation: 18,
          isPaid: true,
          carryForward: true,
          maximumCarryForward: 4,
        },
        status: PolicyStatus.ACTIVE,
      },
      {
        name: 'Retail Shrinkage & Customer Service Policy',
        description: 'Guidelines on customer hospitality and loss prevention',
        policyType: PolicyType.GENERAL,
        configuration: {
          mandatory: true,
          appliesTo: 'ALL_EMPLOYEES',
          reviewCycleMonths: 12,
        },
        status: PolicyStatus.ACTIVE,
      },
    ],
  },
};

/**
 * Returns the matching industry template, or the default business template
 * if the industry is not specifically defined. Guaranteed to never return null.
 */
export function getIndustryTemplate(
  industry: string | null | undefined,
): IndustryTemplate {
  if (industry && INDUSTRY_TEMPLATES[industry]) {
    return INDUSTRY_TEMPLATES[industry];
  }
  return DEFAULT_BUSINESS_TEMPLATE;
}
