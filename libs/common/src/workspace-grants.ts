/**
 * The permissions each owner-capable Projects & Tasks route asks for.
 *
 * The gateway lets a caller without them through to these routes (so a
 * project's owner can manage it without a role that grants it), which means
 * tenant-service's WorkspaceAccessService is where that is decided. Both sides
 * read this one list, and a spec compares it with the gateway routes, so the
 * two cannot drift apart.
 */
export const WORKSPACE_GRANTS = {
  people: ['tasks.view', 'tasks.create', 'tasks.edit', 'tasks.manage', 'projects.create', 'projects.edit', 'projects.manage'],
  taskView: ['tasks.view', 'tasks.manage'],
  taskCreate: ['tasks.create', 'tasks.manage'],
  taskEdit: ['tasks.edit', 'tasks.manage'],
  taskActivity: ['tasks.edit', 'tasks.manage', 'projects.edit', 'projects.manage'],
  taskActivityView: ['tasks.view', 'tasks.manage', 'projects.view', 'projects.manage'],
  projectEdit: ['projects.edit', 'projects.manage'],
  projectOpenTasks: ['projects.view', 'projects.edit', 'projects.manage'],
} as const;
