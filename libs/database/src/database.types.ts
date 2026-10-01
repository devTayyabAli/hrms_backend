export interface DatabaseConfig {
  url?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  dialect: 'postgres' | 'mysql';
  dialectOptions?: any;
  logging: boolean | ((sql: string) => void);
  synchronize: boolean;
  autoLoadEntities: boolean;
  pool?: {
    max: number;
    min: number;
    idle: number;
  };
}

export interface TenantDatabaseConnection {
  tenantId: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  dialect: 'postgres' | 'mysql';
}

export interface DatabaseModuleOptions {
  isPlatform: boolean;
  autoLoadEntities?: boolean;
}

export interface TenantConnectionOptions {
  tenantId: string;
  databaseName?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  dialect?: 'postgres' | 'mysql';
  dialectOptions?: any;
}
