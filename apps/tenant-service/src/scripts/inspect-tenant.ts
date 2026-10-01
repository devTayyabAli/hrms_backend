import * as dotenv from 'dotenv';
import { createPlatformConnection } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main() {
  const connection = createPlatformConnection();
  try {
    const [rows]: any = await connection.query(
      `SELECT * FROM tenants WHERE id = '45da7347-6983-490f-aadf-f3814a062067';`
    );
    console.log('TENANT ROW:', JSON.stringify(rows[0], null, 2));

    const [authCreds]: any = await connection.query(
      `SELECT id, email, role, "tenantId", "createdAt" FROM auth_credentials WHERE "tenantId" = '45da7347-6983-490f-aadf-f3814a062067';`
    );
    console.log('AUTH CREDS:', JSON.stringify(authCreds, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch(console.error);
