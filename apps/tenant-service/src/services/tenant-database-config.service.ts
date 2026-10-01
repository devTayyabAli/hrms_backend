import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { TenantDatabaseConfig, TenantDbStatus } from '../models/tenant-database-config.model';
import { TenantConnectionOptions } from '@app/database';

@Injectable()
export class TenantDatabaseConfigService {
  constructor(
    @InjectModel(TenantDatabaseConfig)
    private tenantDbConfigModel: typeof TenantDatabaseConfig,
  ) {}

  /**
   * Create or update database configuration for a tenant idempotently
   */
  async saveOrUpdateTenantDatabaseConfig(
    tenantId: string,
    databaseName: string,
    host: string,
    port: number,
    username: string,
    password: string,
  ): Promise<TenantDatabaseConfig> {
    const existingConfig = await this.tenantDbConfigModel.findOne({
      where: { tenantId },
    });

    if (existingConfig) {
      return existingConfig.update({
        databaseName,
        host,
        port,
        username,
        password,
        status: TenantDbStatus.ACTIVE,
        isActive: true,
      });
    }

    return this.tenantDbConfigModel.create({
      tenantId,
      databaseName,
      host,
      port,
      username,
      password,
      dialect: 'postgres',
      status: TenantDbStatus.ACTIVE,
      isActive: true,
      poolConfig: {
        max: 5,
        min: 1,
        idle: 10000,
      },
    });
  }

  /**
   * Create database configuration for a new tenant
   */
  async createTenantDatabaseConfig(
    tenantId: string,
    databaseName: string,
    host: string,
    port: number,
    username: string,
    password: string,
  ): Promise<TenantDatabaseConfig> {
    return this.saveOrUpdateTenantDatabaseConfig(
      tenantId,
      databaseName,
      host,
      port,
      username,
      password,
    );
  }

  /**
   * Get database configuration for a tenant
   */
  async getTenantDatabaseConfig(
    tenantId: string,
  ): Promise<TenantConnectionOptions> {
    const config = await this.tenantDbConfigModel.findOne({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Database configuration not found for tenant ${tenantId}`,
      );
    }

    return {
      tenantId,
      databaseName: config.databaseName,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      dialect: config.dialect,
    };
  }

  /**
   * Update database configuration
   */
  async updateTenantDatabaseConfig(
    tenantId: string,
    updates: Partial<TenantDatabaseConfig>,
  ): Promise<TenantDatabaseConfig> {
    const config = await this.tenantDbConfigModel.findOne({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Database configuration not found for tenant ${tenantId}`,
      );
    }

    return config.update(updates);
  }

  /**
   * Delete database configuration
   */
  async deleteTenantDatabaseConfig(tenantId: string): Promise<void> {
    const config = await this.tenantDbConfigModel.findOne({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(
        `Database configuration not found for tenant ${tenantId}`,
      );
    }

    await config.destroy();
  }

  /**
   * Get all active tenant database configurations
   */
  async getAllActiveTenantConfigs(): Promise<TenantDatabaseConfig[]> {
    return this.tenantDbConfigModel.findAll({
      where: { isActive: true },
    });
  }
}
