import * as dotenv from 'dotenv';
import { createPlatformConnection, createTenantConnection } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main() {
  const tenantId = '45da7347-6983-490f-aadf-f3814a062067';
  const platform = createPlatformConnection();
  try {
    const [invitations]: any = await platform.query(
      `SELECT * FROM organization_admin_invitations WHERE "tenantId" = :tenantId`,
      { replacements: { tenantId } }
    );
    console.log('INVITATIONS:', JSON.stringify(invitations, null, 2));

    const [subscriptions]: any = await platform.query(
      `SELECT * FROM subscriptions WHERE "tenantId" = :tenantId`,
      { replacements: { tenantId } }
    );
    console.log('SUBSCRIPTIONS:', JSON.stringify(subscriptions, null, 2));

    const tenantDbName = 'hrms_45da7347_6983_490f_aadf_f3814a062067';
    const tenantDb = createTenantConnection(tenantDbName);
    try {
      const [modules]: any = await tenantDb.query(
        `SELECT "moduleKey", enabled FROM organization_module_access;`
      );
      console.log('TENANT MODULE ACCESS COUNT:', modules.length);
    } catch (e: any) {
      console.log('TENANT MODULE ACCESS ERROR:', e.message);
    } finally {
      await tenantDb.close();
    }
  } finally {
    await platform.close();
  }
}

main().catch(console.error);
