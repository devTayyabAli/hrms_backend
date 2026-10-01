import * as dotenv from 'dotenv';
import { createPlatformConnection } from './lib/tenant-script-utils';

dotenv.config({ path: '.env.development' });
dotenv.config();

async function main() {
  const connection = createPlatformConnection();
  try {
    const [dbs]: any = await connection.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'hrms_%' OR datname = 'neondb';`
    );
    console.log('DATABASES IN PG_DATABASE:', dbs);
  } finally {
    await connection.close();
  }
}

main().catch(console.error);
