import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HRMSModuleKey, ModuleAction } from '@app/common';
import { PERMISSIONS_KEY, REQUIRE_MODULE_KEY } from '@app/tenant-context';
import { CompanyDocumentsController } from './company-documents.controller';
import { MyPoliciesController } from './my-policies.controller';

describe('Policy distribution routes', () => {
  const admin = CompanyDocumentsController.prototype as unknown as Record<string, any>;
  const mine = MyPoliciesController.prototype as unknown as Record<string, any>;
  const meta = (proto: Record<string, any>, name: string) => ({
    route: `${RequestMethod[Reflect.getMetadata('method', proto[name])]} ${Reflect.getMetadata('path', proto[name])}`,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[] | undefined,
    module: Reflect.getMetadata(REQUIRE_MODULE_KEY, proto[name]),
  });

  it('reads with the Documents view permission and changes with its edit permission', () => {
    const view = ['documents.view', 'documents.manage'];
    const edit = ['documents.edit', 'documents.manage'];
    expect(meta(admin, 'getAcknowledgementOverview')).toMatchObject({ route: 'GET acknowledgements/overview', permissions: view, module: { moduleKey: HRMSModuleKey.DOCUMENTS, action: ModuleAction.VIEW } });
    expect(meta(admin, 'getAcknowledgements')).toMatchObject({ route: 'GET :documentId/acknowledgements', permissions: view });
    expect(meta(admin, 'setDistribution')).toMatchObject({ route: 'PUT :documentId/distribution', permissions: edit, module: { moduleKey: HRMSModuleKey.DOCUMENTS, action: ModuleAction.EDIT } });
    expect(meta(admin, 'requestReacknowledgement')).toMatchObject({ route: 'POST :documentId/reacknowledge', permissions: edit });
    expect(meta(admin, 'remind')).toMatchObject({ route: 'POST :documentId/remind', permissions: edit });
  });

  it('asks the employee routes for no permission, only the Documents module', () => {
    expect(meta(mine, 'getMine')).toMatchObject({ route: 'GET /', permissions: undefined });
    expect(meta(mine, 'acknowledge')).toMatchObject({ route: 'POST :documentId/acknowledge', permissions: undefined });
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, MyPoliciesController)).toMatchObject({ moduleKey: HRMSModuleKey.DOCUMENTS, action: ModuleAction.VIEW });
  });
});
