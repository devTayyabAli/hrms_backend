import * as dotenv from 'dotenv';
import { createPlatformConnection } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main() {
  const connection = createPlatformConnection();
  try {
    const [rows]: any = await connection.query(
      `SELECT id, "organizationName", slug, status, "provisioningStatus", "provisioningError", "createdAt" 
       FROM tenants 
       ORDER BY "createdAt" DESC 
       LIMIT 5;`
    );
    console.log('RECENT TENANTS:', JSON.stringify(rows, null, 2));

    const [dbConfigs]: any = await connection.query(
      `SELECT "tenantId", "databaseName", status, "createdAt" 
       FROM tenant_database_configs 
       ORDER BY "createdAt" DESC 
       LIMIT 5;`
    );
    console.log('RECENT DB CONFIGS:', JSON.stringify(dbConfigs, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch(console.error);
