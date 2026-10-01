import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { verifyMicroservicePayload } from '@app/common';

/**
 * Verifies that an incoming microservice message was signed by a party that
 * holds MICROSERVICE_SIGNING_SECRET (i.e. the API gateway), not sent directly
 * to the microservice's TCP port. Apply per-handler (not at controller level)
 * only to message patterns whose gateway caller has been updated to sign its
 * payload via MicroserviceSigningService — every other pattern's envelope
 * won't carry a signature and this guard will correctly reject it.
 */
@Injectable()
export class SignedPayloadGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if ((context.getType() as string) !== 'rpc') {
      return true;
    }

    const secret = this.configService.get<string>('MICROSERVICE_SIGNING_SECRET');
    if (!secret) {
      throw new Error(
        'SECURITY CONFIGURATION ERROR: MICROSERVICE_SIGNING_SECRET environment variable is required and must not be empty.',
      );
    }

    const rpcData = context.switchToRpc().getData();
    if (!verifyMicroservicePayload(rpcData, secret)) {
      throw new RpcException('Invalid or missing request signature');
    }

    return true;
  }
}
