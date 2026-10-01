import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const IS_PLATFORM_ROUTE_KEY = 'isPlatformRoute';
export const IS_TENANT_OPTIONAL_KEY = 'isTenantOptional';

/**
 * Marks a route as public (no authentication required)
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Marks a route as platform-level (SuperAdmin / health checks bypass tenant validation)
 */
export const PlatformRoute = () => SetMetadata(IS_PLATFORM_ROUTE_KEY, true);

/**
 * Marks a route as optional tenant context
 */
export const TenantOptional = () => SetMetadata(IS_TENANT_OPTIONAL_KEY, true);
