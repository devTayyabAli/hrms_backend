import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiHeader,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import {
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
  RequireModule,
  RequirePermissions,
} from '@app/tenant-context';

@Controller('org')
@ApiBearerAuth()
@UseGuards(
  JwtAuthGuard,
  TenantGuard,
  RolesGuard,
  PermissionsGuard,
  OrganizationModuleGuard,
)
@ApiHeader({
  name: 'x-tenant-id',
  description: 'Target Organization Tenant ID',
  required: true,
})
export class OrganizationModulesController {
  @ApiTags(TAGS.ORG_MODULES)
  @Get('dashboard')
  @RequireModule(HRMSModuleKey.DASHBOARD)
  @RequirePermissions('dashboard.view')
  @ApiOperation({ summary: 'Main Dashboard stats & metrics' })
  getDashboard(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      totalEmployees: 42,
      activeProjects: 8,
      pendingLeaves: 3,
      monthlyPayroll: 125000.0,
      recentAnnouncements: [
        { id: '1', title: 'Q3 All Hands Meeting', category: 'Events' },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('geofence/locations')
  @RequireModule(HRMSModuleKey.ATTENDANCE)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Geofencing Attendance boundaries' })
  getGeofenceLocations(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      locations: [
        {
          id: 'geo-1',
          name: 'HQ Office',
          latitude: 37.7749,
          longitude: -122.4194,
          radiusMeters: 100,
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Post('pos/transactions')
  @RequireModule(HRMSModuleKey.PAYROLL, ModuleAction.CREATE)
  @RequirePermissions('payroll.create', 'payroll.manage')
  @ApiOperation({ summary: 'Record Point of Sale (POS) transaction' })
  createPOSTransaction(
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: any,
  ) {
    return {
      tenantId,
      status: 'completed',
      transactionId: 'pos-tx-1001',
      // `??`, not `||` — a legitimate zero-value transaction would otherwise
      // be treated as absent and silently replaced with the sample amount.
      totalAmount: body?.totalAmount ?? 49.99,
      timestamp: new Date().toISOString(),
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('announcements')
  @RequireModule(HRMSModuleKey.SETTINGS)
  @RequirePermissions('settings.view', 'settings.manage')
  @ApiOperation({ summary: 'Notice board and announcements' })
  getAnnouncements(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      announcements: [
        { id: 'ann-1', title: 'Annual Health Checkup Drive', category: 'HR' },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('surveys')
  @RequireModule(HRMSModuleKey.PERFORMANCE)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'Employee surveys and feedback' })
  getSurveys(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      surveys: [
        {
          id: 'surv-1',
          title: 'Q3 Employee Satisfaction Survey',
          status: 'active',
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('web3/nft-rewards')
  @RequireModule(HRMSModuleKey.PERFORMANCE)
  @RequirePermissions('performance.view', 'performance.manage')
  @ApiOperation({ summary: 'NFT & Web3 HR Achievement Badges' })
  getNFTRewards(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      rewards: [
        {
          id: 'nft-1',
          badgeTitle: 'Innovator of the Month',
          tokenId: '7721',
          chain: 'Ethereum',
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('community/posts')
  @RequireModule(HRMSModuleKey.USER_MANAGEMENT)
  @RequirePermissions('user_management.view', 'user_management.manage')
  @ApiOperation({ summary: 'HR Community discussions' })
  getCommunityPosts(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      posts: [
        {
          id: 'post-1',
          title: 'Tips for Work-Life Balance',
          author: 'Jane Doe',
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('penalties')
  @RequireModule(HRMSModuleKey.ATTENDANCE)
  @RequirePermissions('attendance.view', 'attendance.manage')
  @ApiOperation({ summary: 'Interactive communication penalties log' })
  getPenalties(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      penalties: [
        {
          id: 'pen-1',
          reason: 'Unannounced Absence',
          amount: 50.0,
          status: 'resolved',
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('assets')
  @RequireModule(HRMSModuleKey.ASSETS)
  @RequirePermissions('assets.view', 'assets.manage')
  @ApiOperation({ summary: 'Asset Management list' })
  getAssets(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      assets: [
        {
          id: 'ast-1',
          name: 'MacBook Pro 16"',
          tag: 'AST-2026-01',
          status: 'assigned',
        },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('expenses')
  @RequireModule(HRMSModuleKey.EXPENSES)
  @RequirePermissions('expenses.view', 'expenses.manage')
  @ApiOperation({ summary: 'Expense claims & approvals' })
  getExpenses(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      claims: [
        { id: 'exp-1', category: 'Travel', amount: 350.0, status: 'submitted' },
      ],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('tickets')
  @RequireModule(HRMSModuleKey.TICKETS)
  @RequirePermissions('tickets.view', 'tickets.manage')
  @ApiOperation({ summary: 'Helpdesk & Ticket Management' })
  getTickets(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      tickets: [{ id: 'tkt-1', subject: 'VPN Access issue', status: 'open' }],
    };
  }

  @ApiTags(TAGS.ORG_MODULES)
  @Get('audit-logs')
  @RequireModule(HRMSModuleKey.REPORTS)
  @RequirePermissions('reports.view', 'reports.manage')
  @ApiOperation({ summary: 'Audit trail and system activity logs' })
  getAuditLogs(@Headers('x-tenant-id') tenantId: string) {
    return {
      tenantId,
      logs: [
        {
          id: 'log-1',
          action: 'ROLE_UPDATE',
          performedBy: 'Admin',
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }
}
