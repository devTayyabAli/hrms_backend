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
       ORDER BY "createdAt" DESC;`
    );
    console.log('ALL TENANTS:', JSON.stringify(rows, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch(console.error);
