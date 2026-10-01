import { DatabaseConfig } from '../database.types';
import { resolveDbCredentials } from './db-credentials.util';

export const getDatabaseConfig = (isPlatform: boolean): DatabaseConfig => {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isPlatform) {
    const creds = resolveDbCredentials('platform');
    return {
      host: creds.host,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      database: process.env.PLATFORM_DB_NAME || 'neondb',
      dialect: 'postgres',
      dialectOptions: creds.dialectOptions,
      logging: isDev ? console.log : false,
      synchronize: isDev,
      autoLoadEntities: true,
      pool: {
        max: 10,
        min: 2,
        idle: 10000,
      },
    };
  }

  // Template for tenant databases
  const creds = resolveDbCredentials('tenant');
  return {
    host: creds.host,
    port: creds.port,
    username: creds.username,
    password: creds.password,
    database: process.env.PLATFORM_DB_NAME || 'neondb',
    dialect: 'postgres',
    dialectOptions: creds.dialectOptions,
    logging: isDev ? console.log : false,
    synchronize: isDev,
    autoLoadEntities: true,
    pool: {
      max: 5,
      min: 1,
      idle: 10000,
    },
  };
};
