import { SetMetadata } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';

export const REQUIRE_MODULE_KEY = 'require_module';

export interface RequiredModuleMetadata {
  moduleKey: string | HRMSModuleKey;
  action?: string | ModuleAction;
}

export const RequireModule = (
  moduleKey: string | HRMSModuleKey,
  action?: string | ModuleAction,
) => SetMetadata(REQUIRE_MODULE_KEY, { moduleKey, action });
