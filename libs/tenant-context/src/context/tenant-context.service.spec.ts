import { TenantContextService, tenantStorage } from './tenant-context.service';

/**
 * The request context is opened by middleware before the user is known and
 * filled in by guards after the JWT guard has run. Nest awaits between those
 * steps, so an update has to reach the handler that runs afterwards — it is
 * what gets signed into every outgoing RPC.
 */
describe('TenantContextService', () => {
  const service = new TenantContextService();
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('keeps an update made after an await visible to later steps of the request', async () => {
    let seenByHandler: string[] | undefined;

    await tenantStorage.run({ tenantId: 't1', roles: [] }, async () => {
      // Guard chain: the JWT guard is async, so the tenant guard runs after an await.
      const runGuards = async () => {
        await tick();
        service.setContext({ userId: 'u1', roles: ['ORGANIZATION_ADMIN'] });
      };
      await runGuards();
      await tick();
      // Controller: signs its RPC with whatever the context holds now.
      seenByHandler = service.getContext()?.roles;
    });

    expect(seenByHandler).toEqual(['ORGANIZATION_ADMIN']);
  });

  it('does not leak one request’s context into another', async () => {
    const results: (string | undefined)[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        tenantStorage.run({ tenantId: id }, async () => {
          await tick();
          service.setContext({ userId: `user-${id}` });
          await tick();
          results.push(`${service.getTenantId()}:${service.getUserId()}`);
        }),
      ),
    );
    expect(results.sort()).toEqual(['a:user-a', 'b:user-b']);
  });
});
