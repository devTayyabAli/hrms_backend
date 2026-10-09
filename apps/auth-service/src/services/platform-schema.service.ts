import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { addMissingColumns } from '@app/database';

/**
 * Brings existing platform tables up to date with their models on start.
 *
 * `sync()` (on in development, and in production with DB_SYNC=true) creates
 * missing tables but never adds a column to one that exists, so a new setting
 * stored in an existing table — security_settings, platform_domains — would
 * fail at runtime until someone ran the column script by hand. This runs the
 * same additive-only reconciliation automatically, under the same switch.
 */
@Injectable()
export class PlatformSchemaService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformSchemaService.name);

  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async onApplicationBootstrap() {
    const enabled = process.env.NODE_ENV !== 'production' || process.env.DB_SYNC === 'true';
    if (!enabled || process.env.NODE_ENV === 'test') return;
    try {
      const { added, relaxed } = await addMissingColumns(this.sequelize, { log: (m) => this.logger.log(m) });
      if (added.length) this.logger.log(`Platform schema: added ${added.length} column(s).`);
      if (relaxed.length) this.logger.warn(`Added as nullable, backfill then tighten: ${relaxed.join(', ')}`);
    } catch (error: any) {
      // A failed reconciliation must not stop the service; the affected feature reports its own error.
      this.logger.error(`Platform column reconciliation failed: ${error?.message ?? error}`);
    }
  }
}
