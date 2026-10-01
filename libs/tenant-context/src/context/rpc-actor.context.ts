import { AsyncLocalStorage } from 'async_hooks';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { MicroserviceAuthContext } from '@app/common';

/**
 * Who a microservice message is from, as the gateway signed it.
 *
 * RpcSignatureGuard verifies the signature and records the context here,
 * keyed by the message payload object; RpcActorInterceptor then runs the
 * handler inside that context, so any service code can ask `currentRpcActor()`
 * without every handler threading an `actor` argument through. Only verified
 * contexts are ever recorded, so what a service reads here is what the
 * caller's JWT said — not something a message could claim for itself.
 */
const verifiedByPayload = new WeakMap<object, MicroserviceAuthContext>();
const actorStorage = new AsyncLocalStorage<MicroserviceAuthContext>();

/** Called by RpcSignatureGuard once a signature checks out. */
export const rememberRpcActor = (payload: unknown, context: MicroserviceAuthContext | undefined) => {
  if (context && payload && typeof payload === 'object') verifiedByPayload.set(payload, context);
};

/** The signed caller of the message being handled, if it was signed. */
export const currentRpcActor = (): MicroserviceAuthContext | undefined => actorStorage.getStore();

/** Runs `work` as if handling a message from `actor` — for tests and jobs. */
export const runAsRpcActor = <T>(actor: MicroserviceAuthContext, work: () => T): T => actorStorage.run(actor, work);

/** Makes the verified caller available to everything the handler calls. */
@Injectable()
export class RpcActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'rpc') return next.handle();
    const actor = verifiedByPayload.get(context.switchToRpc().getData() as object);
    if (!actor) return next.handle();
    // Subscribing inside `run` is what places the handler — and every await
    // it makes — in the actor's context.
    return new Observable((subscriber) =>
      actorStorage.run(actor, () => next.handle().subscribe(subscriber)),
    );
  }
}
