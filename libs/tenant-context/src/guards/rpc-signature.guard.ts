import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import {
  isSignedEnvelope,
  verifyAndStripRpcSignature,
  verifyMicroservicePayload,
} from '@app/common';
import { ALLOW_UNSIGNED_RPC_KEY } from '../decorators/allow-unsigned-rpc.decorator';
import { rememberRpcActor } from '../context/rpc-actor.context';

/**
 * Requires every inbound microservice message to carry a valid HMAC signature
 * from a party holding MICROSERVICE_SIGNING_SECRET.
 *
 * Registered globally (APP_GUARD) in each microservice, which is the point:
 * each service's TCP port exposes every one of its @MessagePattern handlers —
 * login, credential creation, tenant provisioning, billing, employee records
 * across every tenant database — and the gateway's JWT and guard stack runs in
 * a different process and protects none of it. Per-handler signing existed but
 * had reached thirteen patterns out of roughly 260, so in practice the ports
 * were an unauthenticated admin API for anything that could reach them.
 *
 * Both signature forms are accepted:
 *
 *   - the nested `SignedMicroservicePayload` envelope, used by handlers that
 *     want the caller's identity in their own signature, and
 *   - the attached `__rpcAuth` property, which leaves the payload's shape
 *     alone and so can cover every other handler without rewriting it. The
 *     property is stripped here, before the validation pipe would reject it
 *     as a non-whitelisted field.
 *
 * Enforcement defaults on in production and off elsewhere, matching the
 * convention already used for TENANT_DB_AUTO_SYNC. Off, an unsigned message
 * is logged and allowed, so a partially-deployed environment (an old gateway
 * against a new service) still works; on, it is rejected. Set
 * MICROSERVICE_SIGNING_ENFORCED explicitly to override either way — enabling
 * it outside production is the right move for any environment reachable by
 * anyone other than the developer running it.
 */
@Injectable()
export class RpcSignatureGuard implements CanActivate {
  private readonly logger = new Logger(RpcSignatureGuard.name);

  /** Logged once per process rather than per message. */
  private warnedUnenforced = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  private get enforced(): boolean {
    const flag = this.configService.get<string>(
      'MICROSERVICE_SIGNING_ENFORCED',
    );
    if (flag !== undefined && flag !== '') {
      return flag === 'true';
    }
    return this.configService.get<string>('NODE_ENV') === 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType<string>() !== 'rpc') {
      return true;
    }

    // Opt-out for the handful of patterns that are genuinely called by
    // something that cannot hold the signing secret.
    const allowUnsigned = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNSIGNED_RPC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowUnsigned) {
      return true;
    }

    const secret = this.configService.get<string>(
      'MICROSERVICE_SIGNING_SECRET',
    );
    if (!secret) {
      throw new Error(
        'SECURITY CONFIGURATION ERROR: MICROSERVICE_SIGNING_SECRET environment variable is required and must not be empty.',
      );
    }

    const data = context.switchToRpc().getData();
    const handler = `${context.getClass().name}.${context.getHandler().name}`;

    // The nested envelope verifies as a whole and is left intact — handlers
    // using it read `envelope.data` and `envelope.context` themselves.
    if (isSignedEnvelope(data)) {
      if (verifyMicroservicePayload(data, secret)) {
        rememberRpcActor(data, data.context);
        return true;
      }
      return this.reject(handler, 'invalid signed envelope');
    }

    const result = verifyAndStripRpcSignature(data, secret);
    if (result.valid) {
      rememberRpcActor(data, result.context);
      return true;
    }

    return this.reject(handler, result.reason ?? 'unsigned message');
  }

  private reject(handler: string, reason: string): boolean {
    if (this.enforced) {
      // Deliberately vague to the caller, specific in the log: the reason
      // distinguishes "expired" from "wrong secret" from "not signed at
      // all", which is useful to an operator and an oracle to an attacker.
      this.logger.warn(
        `Rejected unsigned/invalid RPC to ${handler}: ${reason}`,
      );
      throw new RpcException('Invalid or missing request signature');
    }

    if (!this.warnedUnenforced) {
      this.warnedUnenforced = true;
      this.logger.warn(
        'MICROSERVICE_SIGNING_ENFORCED is off — unsigned messages are being accepted. ' +
          'This TCP port is an unauthenticated admin API in this mode; enable enforcement ' +
          'for any environment reachable by more than the local developer.',
      );
    }
    this.logger.debug(`Allowing unsigned RPC to ${handler}: ${reason}`);
    return true;
  }
}
