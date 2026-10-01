import * as dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { TenantServiceModule } from '../tenant-service.module';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main() {
  const app = await NestFactory.createApplicationContext(TenantServiceModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  const provisioningService = app.get(TenantProvisioningService);

  const testPayload = {
    organizationInfo: {
      organizationName: 'Test Org Flow',
      legalName: 'Test Org Flow LLC',
      businessEmail: 'contact@testorgflow.com',
      phone: '+1234567890',
      country: 'United States',
      industry: 'Technology',
      companySize: '11-50',
    },
    adminInfo: {
      adminName: 'John Doe',
      adminEmail: 'admin@testorgflow.com',
      adminPhone: '+1234567890',
      sendInvitation: true,
      customMessage: 'Welcome to Test Org Flow',
    },
    modules: [
      { moduleKey: 'dashboard', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'employee', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'departments', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'attendance', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'leave_management', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'payroll', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'performance', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'reports', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'settings', enabled: true, allowedActions: ['all'] },
      { moduleKey: 'user_management', enabled: true, allowedActions: ['all'] },
    ],
  };

  try {
    console.log('>>> Calling createOrganizationAndProvision...');
    const result = await provisioningService.createOrganizationAndProvision(testPayload);
    console.log('>>> RESULT:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('>>> CAUGHT ERROR IN PROVISIONING:', err);
    if (err.stack) console.error(err.stack);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
