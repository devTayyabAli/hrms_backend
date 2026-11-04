import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const ALLOW_PROJECT_OWNER_KEY = 'allowProjectOwner';

/**
 * Lets a caller who lacks the route's permission through, on the understanding
 * that the service behind the route then checks they are the owner of the
 * project the request is about, and refuses them if not. Only for routes
 * whose handler does that check — without it this would open the route.
 */
export const AllowProjectOwner = () => SetMetadata(ALLOW_PROJECT_OWNER_KEY, true);
