import { Module, DynamicModule } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { getDatabaseConfig } from './config/database.config';
import { DatabaseModuleOptions } from './database.types';

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    const config = getDatabaseConfig(options.isPlatform);

    return {
      module: DatabaseModule,
      imports: [
        SequelizeModule.forRoot({
          ...config,
          autoLoadModels: options.autoLoadEntities ?? true,
        }),
      ],
      exports: [SequelizeModule],
    };
  }

  static forFeature(models: any[]) {
    return SequelizeModule.forFeature(models);
  }
}
