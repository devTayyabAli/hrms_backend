import {
  TenantProvisioningStatus,
  TenantSetupRequest,
} from '../models/tenant.model';

export type SetupState = 'ready' | 'running' | 'failed';

/** A setup with no progress for this long was interrupted (the service restarted mid-way). */
export const STALE_SETUP_MS = 15 * 60 * 1000;

const INTERRUPTED =
  'Setup stopped before it finished (the service restarted). Retry to complete it.';

/**
 * Where an organization's setup stands, from its tenant row: the database,
 * then module access, the invitation and the subscription. `running` comes
 * from the caller, who knows whether this process is working on it.
 */
export const setupStateOf = (
  tenant: {
    provisioningStatus: TenantProvisioningStatus;
    provisioningError?: string | null;
    setupRequest?: TenantSetupRequest | null;
    updatedAt: Date | string;
  },
  running: boolean,
  now = Date.now(),
): { state: SetupState; error: string | null } => {
  if (running) return { state: 'running', error: null };

  const request = tenant.setupRequest;
  if (tenant.provisioningStatus === TenantProvisioningStatus.FAILED) {
    return {
      state: 'failed',
      error:
        request?.lastError ||
        tenant.provisioningError ||
        'The database could not be set up.',
    };
  }
  if (request?.lastError && !request.completedAt)
    return { state: 'failed', error: request.lastError };

  const stale = now - new Date(tenant.updatedAt).getTime() > STALE_SETUP_MS;
  const unfinished =
    tenant.provisioningStatus !== TenantProvisioningStatus.READY ||
    (request != null && !request.completedAt);
  if (unfinished)
    return stale
      ? { state: 'failed', error: INTERRUPTED }
      : { state: 'running', error: null };

  return { state: 'ready', error: null };
};
