import { lastValueFrom, Observable } from 'rxjs';
import { RpcActorInterceptor, currentRpcActor, rememberRpcActor } from './rpc-actor.context';

/**
 * The signature guard records the verified caller against the payload; the
 * interceptor has to make it visible to the handler and everything the
 * handler awaits — that is what services scope data by.
 */
describe('RpcActorInterceptor', () => {
  const interceptor = new RpcActorInterceptor();
  const rpcContext = (payload: object) =>
    ({
      getType: () => 'rpc',
      switchToRpc: () => ({ getData: () => payload }),
    }) as any;

  it('runs the handler as the verified caller, across awaits', async () => {
    const payload = { employeeId: 'e1' };
    rememberRpcActor(payload, { roles: ['Team Lead'], isSuperAdmin: false, email: 'lead@x.com', dataScope: 'TEAM' });

    const handler = {
      handle: () =>
        new Observable((subscriber) => {
          (async () => {
            await new Promise((resolve) => setImmediate(resolve));
            subscriber.next(currentRpcActor()?.dataScope);
            subscriber.complete();
          })();
        }),
    };

    await expect(lastValueFrom(interceptor.intercept(rpcContext(payload), handler))).resolves.toBe('TEAM');
  });

  it('leaves unsigned messages without an actor', async () => {
    const handler = {
      handle: () =>
        new Observable((subscriber) => {
          subscriber.next(currentRpcActor());
          subscriber.complete();
        }),
    };
    await expect(lastValueFrom(interceptor.intercept(rpcContext({}), handler))).resolves.toBeUndefined();
  });
});
