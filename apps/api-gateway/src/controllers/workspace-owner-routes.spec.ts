import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { WORKSPACE_GRANTS } from '@app/common';
import { ALLOW_PROJECT_OWNER_KEY, PERMISSIONS_KEY } from '@app/tenant-context';
import { WorkspaceController } from './workspace.controller';

/**
 * Routes marked for project owners let a caller without the permission reach
 * the handler; tenant-service then checks they own the project. So the set of
 * marked routes has to be exactly the set tenant-service checks, and the
 * permissions each asks for have to be the ones it checks against.
 */
describe('WorkspaceController: routes a project owner may use', () => {
  const methodName = (code: number) => RequestMethod[code].toUpperCase();

  const routes = () => {
    const prototype = WorkspaceController.prototype as unknown as Record<string, unknown>;
    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function')
      .map((name) => {
        const handler = prototype[name] as object;
        return {
          route: `${methodName(Reflect.getMetadata('method', handler))} ${Reflect.getMetadata('path', handler)}`,
          permissions: (Reflect.getMetadata(PERMISSIONS_KEY, handler) ?? []) as string[],
          ownerMayAct: Reflect.getMetadata(ALLOW_PROJECT_OWNER_KEY, handler) === true,
        };
      });
  };

  /** Route -> the grants tenant-service checks it against (null: the handler's own rule decides). */
  const EXPECTED: Record<string, readonly string[] | null> = {
    'GET people': WORKSPACE_GRANTS.people,
    'GET tasks': WORKSPACE_GRANTS.taskView,
    'GET tasks/:taskId': WORKSPACE_GRANTS.taskView,
    'POST tasks': WORKSPACE_GRANTS.taskCreate,
    'PATCH tasks/:taskId': WORKSPACE_GRANTS.taskEdit,
    // Reviewing: the service lets the project owner, or a manager, decide; nobody else.
    'POST tasks/:taskId/review': null,
    'POST tasks/:taskId/comments': WORKSPACE_GRANTS.taskActivity,
    'DELETE tasks/:taskId/comments/:commentId': WORKSPACE_GRANTS.taskActivity,
    'POST tasks/:taskId/checklist': WORKSPACE_GRANTS.taskEdit,
    'PATCH tasks/:taskId/checklist/:itemId': WORKSPACE_GRANTS.taskEdit,
    'DELETE tasks/:taskId/checklist/:itemId': WORKSPACE_GRANTS.taskEdit,
    'POST tasks/:taskId/attachments': WORKSPACE_GRANTS.taskActivity,
    'DELETE tasks/:taskId/attachments/:attachmentId': WORKSPACE_GRANTS.taskActivity,
    'GET tasks/:taskId/attachments/:attachmentId/download': WORKSPACE_GRANTS.taskActivityView,
    'PATCH projects/:projectId': WORKSPACE_GRANTS.projectEdit,
    'GET projects/:projectId/open-tasks': WORKSPACE_GRANTS.projectOpenTasks,
  };

  it('marks exactly the routes tenant-service guards', () => {
    const marked = routes()
      .filter((route) => route.ownerMayAct)
      .map((route) => route.route)
      .sort();

    expect(marked).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED).filter(([, grants]) => grants !== null))(
    '%s asks for the same permissions tenant-service checks',
    (route, grants) => {
      const found = routes().find((candidate) => candidate.route === route);

      expect(found).toBeDefined();
      expect([...found!.permissions].sort()).toEqual([...grants!].sort());
    },
  );

  it('does not open deleting a task or a project, creating a project, or the project list to owners', () => {
    const closed = routes().filter((route) =>
      ['DELETE tasks/:taskId', 'DELETE projects/:projectId', 'POST projects', 'GET projects', 'GET projects/export', 'GET tasks/export', 'PATCH settings'].includes(
        route.route,
      ),
    );

    expect(closed.length).toBeGreaterThanOrEqual(5);
    expect(closed.every((route) => !route.ownerMayAct)).toBe(true);
  });
});
