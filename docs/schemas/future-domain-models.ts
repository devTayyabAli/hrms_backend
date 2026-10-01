import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  HasMany,
  CreatedAt,
  UpdatedAt,
  Default,
  PrimaryKey,
  IsUUID,
} from 'sequelize-typescript';

// ============================================================================
// TENANT & ORG BOUNDARY
// ============================================================================

@Table({ tableName: 'tenants' })
export class Tenant extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column({ unique: true, allowNull: false })
  declare domain: string;

  @Default('active')
  @Column
  declare status: string;

  @HasMany(() => User)
  declare users: User[];

  @HasMany(() => Department)
  declare departments: Department[];

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}

@Table({ tableName: 'roles' })
export class Role extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column(DataType.ARRAY(DataType.STRING))
  declare permissions: string[];

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;
}

@Table({ tableName: 'users' })
export class User extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false, unique: true })
  declare email: string;

  @Column({ allowNull: false })
  declare passwordHash: string;

  @ForeignKey(() => Role)
  @Column
  declare roleId: string;

  @Default(true)
  @Column
  declare isActive: boolean;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => Role)
  declare role: Role;
}

@Table({ tableName: 'departments' })
export class Department extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;
}

@Table({ tableName: 'designations' })
export class Designation extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;
}

// ============================================================================
// EMPLOYEE CORE
// ============================================================================

@Table({ tableName: 'employee_profiles' })
export class EmployeeProfile extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => User)
  @Column
  declare userId: string;

  @Column({ allowNull: false })
  declare firstName: string;

  @Column({ allowNull: false })
  declare lastName: string;

  @Column({ unique: true })
  declare employeeCode: string;

  @ForeignKey(() => Department)
  @Column
  declare departmentId: string;

  @ForeignKey(() => Designation)
  @Column
  declare designationId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column
  declare managerId: string;

  @Column(DataType.DATEONLY)
  declare joiningDate: Date;

  @Default('active')
  @Column
  declare employmentStatus: string;

  @BelongsTo(() => Tenant)
  declare tenant: Tenant;

  @BelongsTo(() => User)
  declare user: User;

  @BelongsTo(() => Department)
  declare department: Department;

  @BelongsTo(() => Designation)
  declare designation: Designation;

  @BelongsTo(() => EmployeeProfile, 'managerId')
  declare manager: EmployeeProfile;
}

// ============================================================================
// ATTENDANCE & LEAVE
// ============================================================================

@Table({ tableName: 'attendances' })
export class Attendance extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column(DataType.DATEONLY)
  declare date: Date;

  @Column(DataType.DATE)
  declare checkInTime: Date;

  @Column(DataType.DATE)
  declare checkOutTime: Date;

  @Default('present')
  @Column
  declare status: string;
}

@Table({ tableName: 'leave_requests' })
export class LeaveRequest extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column
  declare leaveType: string;

  @Column(DataType.DATEONLY)
  declare startDate: Date;

  @Column(DataType.DATEONLY)
  declare endDate: Date;

  @Default('pending')
  @Column
  declare status: string;
}

// ============================================================================
// PAYROLL
// ============================================================================

@Table({ tableName: 'salary_structures' })
export class SalaryStructure extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column(DataType.DECIMAL(12, 2))
  declare baseSalary: number;

  @Column(DataType.JSONB)
  declare allowances: object;

  @Column(DataType.JSONB)
  declare deductions: object;
}

@Table({ tableName: 'payroll_records' })
export class PayrollRecord extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column
  declare payPeriod: string;

  @Column(DataType.DECIMAL(12, 2))
  declare netPay: number;

  @Default('draft')
  @Column
  declare status: string;
}

// ============================================================================
// PERFORMANCE & WORK MANAGEMENT (Core Linkage)
// PRD 8.3: Project -> Task -> Employee Output -> Goal/KPI -> Performance Review
// ============================================================================

@Table({ tableName: 'goals' })
export class Goal extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.TEXT)
  declare targetMetric: string;

  @Default('in_progress')
  @Column
  declare status: string;
}

@Table({ tableName: 'projects' })
export class Project extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Default('active')
  @Column
  declare status: string;
}

@Table({ tableName: 'tasks' })
export class Task extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Project)
  @Column({ allowNull: false })
  declare projectId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column
  declare assigneeId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Default('todo')
  @Column
  declare status: string;
}

@Table({ tableName: 'employee_outputs' })
export class EmployeeOutput extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @ForeignKey(() => Task)
  @Column
  declare taskId: string;

  @ForeignKey(() => Goal)
  @Column
  declare goalId: string;

  @Column(DataType.TEXT)
  declare outputSummary: string;

  @Column(DataType.INTEGER)
  declare qualityScore: number;
}

@Table({ tableName: 'performance_reviews' })
export class PerformanceReview extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column
  declare reviewerId: string;

  @Column
  declare reviewPeriod: string;

  @Column(DataType.JSONB)
  declare selfAssessment: object;

  @Column(DataType.JSONB)
  declare managerAssessment: object;

  @Default('draft')
  @Column
  declare status: string;
}

// ============================================================================
// RECRUITMENT & TALENT (PRD 9 & 24)
// Note: CandidateProfile is reusable across tenants in Phase 2
// ============================================================================

@Table({ tableName: 'candidate_profiles' })
export class CandidateProfile extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false })
  declare firstName: string;

  @Column({ allowNull: false })
  declare lastName: string;

  @Column({ allowNull: false, unique: true })
  declare email: string;

  @Column(DataType.TEXT)
  declare cvUrl: string;

  @Column(DataType.ARRAY(DataType.STRING))
  declare skills: string[];
}

@Table({ tableName: 'job_postings' })
export class JobPosting extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.TEXT)
  declare description: string;

  @Default('open')
  @Column
  declare status: string;
}

@Table({ tableName: 'job_applications' })
export class JobApplication extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => JobPosting)
  @Column({ allowNull: false })
  declare jobPostingId: string;

  @ForeignKey(() => CandidateProfile)
  @Column({ allowNull: false })
  declare candidateId: string;

  @Default('applied')
  @Column
  declare stage: string;
}

// ============================================================================
// LMS
// ============================================================================

@Table({ tableName: 'courses' })
export class Course extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.TEXT)
  declare description: string;
}

@Table({ tableName: 'course_enrollments' })
export class CourseEnrollment extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => Course)
  @Column({ allowNull: false })
  declare courseId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Default(0)
  @Column
  declare progressPercentage: number;

  @Default('enrolled')
  @Column
  declare status: string;
}

// ============================================================================
// SUPER ADMIN & SYSTEM BOUNDARY
// ============================================================================

@Table({ tableName: 'super_admins' })
export class SuperAdmin extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @Column({ allowNull: false, unique: true })
  declare email: string;

  @Column({ allowNull: false })
  declare passwordHash: string;

  @Column
  declare name: string;

  @Column
  declare resetOtp: string;

  @Column(DataType.DATE)
  declare resetOtpExpiresAt: Date;

  @Column(DataType.ARRAY(DataType.STRING))
  declare passwordHistory: string[];

  @Default('active')
  @Column
  declare status: string;
}

@Table({ tableName: 'tenant_database_configs' })
export class TenantDatabaseConfig extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false, unique: true })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare dbHost: string;

  @Column({ allowNull: false })
  declare dbPort: number;

  @Column({ allowNull: false })
  declare dbName: string;

  @Column({ allowNull: false })
  declare dbUsername: string;

  @Column({ allowNull: false })
  declare dbPasswordHash: string;

  @Default('active')
  @Column
  declare connectionStatus: string;
}

// ============================================================================
// GEOFENCING & POS MANAGEMENT
// ============================================================================

@Table({ tableName: 'geofence_locations' })
export class GeofenceLocation extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column(DataType.FLOAT)
  declare latitude: number;

  @Column(DataType.FLOAT)
  declare longitude: number;

  @Column(DataType.FLOAT)
  declare radiusMeters: number;
}

@Table({ tableName: 'pos_transactions' })
export class POSTransaction extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column
  declare cashierEmployeeId: string;

  @Column(DataType.DECIMAL(10, 2))
  declare totalAmount: number;

  @Column
  declare paymentMethod: string;

  @Default('completed')
  @Column
  declare status: string;
}

// ============================================================================
// ANNOUNCEMENTS, SURVEYS & COMMUNITY
// ============================================================================

@Table({ tableName: 'announcements' })
export class Announcement extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.TEXT)
  declare content: string;

  @Column
  declare category: string;
}

@Table({ tableName: 'surveys' })
export class Survey extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.JSONB)
  declare questions: object;

  @Default('active')
  @Column
  declare status: string;
}

@Table({ tableName: 'hr_community_posts' })
export class HRCommunityPost extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare authorEmployeeId: string;

  @Column({ allowNull: false })
  declare title: string;

  @Column(DataType.TEXT)
  declare content: string;
}

// ============================================================================
// WEB3 / NFT CREDENTIALS & PENALTIES
// ============================================================================

@Table({ tableName: 'nft_rewards' })
export class NFTReward extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare recipientEmployeeId: string;

  @Column({ allowNull: false })
  declare badgeTitle: string;

  @Column
  declare tokenId: string;

  @Column
  declare contractAddress: string;

  @Column
  declare transactionHash: string;
}

@Table({ tableName: 'communication_penalties' })
export class CommunicationPenalty extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column({ allowNull: false })
  declare reason: string;

  @Column(DataType.DECIMAL(10, 2))
  declare penaltyAmount: number;

  @Default('pending')
  @Column
  declare status: string;
}

// ============================================================================
// ASSETS, EXPENSES, TICKETS & WORKFLOWS
// ============================================================================

@Table({ tableName: 'assets' })
export class Asset extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @Column({ allowNull: false })
  declare name: string;

  @Column
  declare assetTag: string;

  @ForeignKey(() => EmployeeProfile)
  @Column
  declare assignedEmployeeId: string;

  @Default('available')
  @Column
  declare status: string;
}

@Table({ tableName: 'expense_claims' })
export class ExpenseClaim extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare employeeId: string;

  @Column(DataType.DECIMAL(10, 2))
  declare amount: number;

  @Column
  declare category: string;

  @Column(DataType.TEXT)
  declare description: string;

  @Default('submitted')
  @Column
  declare status: string;
}

@Table({ tableName: 'tickets' })
export class Ticket extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column({ allowNull: false })
  declare tenantId: string;

  @ForeignKey(() => EmployeeProfile)
  @Column({ allowNull: false })
  declare requesterEmployeeId: string;

  @Column({ allowNull: false })
  declare subject: string;

  @Column(DataType.TEXT)
  declare description: string;

  @Default('open')
  @Column
  declare status: string;
}

@Table({ tableName: 'audit_logs' })
export class AuditLog extends Model {
  @IsUUID(4)
  @PrimaryKey
  @Default(DataType.UUIDV4)
  @Column
  declare id: string;

  @ForeignKey(() => Tenant)
  @Column
  declare tenantId: string;

  @Column
  declare action: string;

  @Column
  declare performedBy: string;

  @Column(DataType.JSONB)
  declare details: object;
}

export const ALL_MODELS = [
  Tenant,
  User,
  Role,
  Department,
  Designation,
  EmployeeProfile,
  Attendance,
  LeaveRequest,
  SalaryStructure,
  PayrollRecord,
  Goal,
  Project,
  Task,
  EmployeeOutput,
  PerformanceReview,
  CandidateProfile,
  JobPosting,
  JobApplication,
  Course,
  CourseEnrollment,
  SuperAdmin,
  TenantDatabaseConfig,
  GeofenceLocation,
  POSTransaction,
  Announcement,
  Survey,
  HRCommunityPost,
  NFTReward,
  CommunicationPenalty,
  Asset,
  ExpenseClaim,
  Ticket,
  AuditLog,
];

