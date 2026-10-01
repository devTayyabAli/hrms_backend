import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNSIGNED_RPC_KEY = 'allowUnsignedRpc';

/**
 * Exempts one @MessagePattern handler from RpcSignatureGuard.
 *
 * Only for patterns whose caller genuinely cannot hold
 * MICROSERVICE_SIGNING_SECRET — in practice, liveness probes invoked by
 * orchestration. Every such handler is reachable unauthenticated by anything
 * that can open the port, so an exempt handler must read no tenant data, take
 * no parameters that steer it, and change nothing.
 *
 * It is not an escape hatch for a caller that has not been updated to sign:
 * for that, leave MICROSERVICE_SIGNING_ENFORCED off until it has been.
 */
export const AllowUnsignedRpc = () => SetMetadata(ALLOW_UNSIGNED_RPC_KEY, true);
