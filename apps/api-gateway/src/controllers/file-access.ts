import { ForbiddenException, NotFoundException } from '@nestjs/common';

/** The caller as the JWT describes them. */
export interface FileCaller {
  id?: string;
  sub?: string;
  tenantId?: string | null;
  isSuperAdmin?: boolean;
  isFullAccess?: boolean;
  roles?: string[];
  permissions?: string[];
}

/** The stored file, as `FILE.GET_METADATA` returns it. */
export interface StoredFileMeta {
  tenantId: string;
  uploadedBy: string | null;
  category: string | null;
}

export type FileAction = 'read' | 'delete';

export const isSuperAdminCaller = (user: FileCaller | undefined) =>
  Boolean(
    user?.isSuperAdmin ||
    user?.roles?.some((r) => String(r).toLowerCase() === 'superadmin'),
  );

const isFullAccess = (user: FileCaller) =>
  Boolean(user.isFullAccess || user.permissions?.includes('*'));

/**
 * Who besides the uploader may reach a file of each category through the
 * generic `/files` routes. Anything not listed is uploader-or-admin only.
 * Feature routes (employee documents, payslips) do their own ownership
 * checks and stream files without going through these rules.
 */
const CATEGORY_PERMISSIONS: Record<string, Record<FileAction, string[]>> = {
  // Company documents — shared with whoever may see the documents module.
  documents: {
    read: ['documents.view', 'documents.manage'],
    // An edit replaces the file, so editors remove the previous one.
    delete: ['documents.delete', 'documents.edit', 'documents.manage'],
  },
  'reimbursement-receipt': {
    read: ['payroll.view', 'payroll.manage'],
    delete: ['payroll.manage'],
  },
};

/** Categories only the platform itself writes. */
export const RESERVED_UPLOAD_CATEGORIES = new Set(['backups', 'reports']);

/**
 * Decides whether the caller may read or delete a stored file. The file
 * store itself only checks the tenant; this adds who within the tenant:
 * the uploader, an organization admin, or someone holding the category's
 * permission. Other tenants' files — and platform files — read as not found.
 */
export const assertFileAccess = (
  user: FileCaller | undefined,
  file: StoredFileMeta,
  action: FileAction,
) => {
  if (!user)
    throw new ForbiddenException(
      'You do not have permission to access this file.',
    );
  if (isSuperAdminCaller(user)) return;

  if (!user.tenantId || file.tenantId !== user.tenantId) {
    throw new NotFoundException('File not found.');
  }
  if (isFullAccess(user)) return;

  const callerId = user.id || user.sub;
  if (callerId && file.uploadedBy === callerId) return;

  const allowed = CATEGORY_PERMISSIONS[file.category ?? '']?.[action] ?? [];
  if (allowed.some((permission) => user.permissions?.includes(permission)))
    return;

  throw new ForbiddenException(
    'You do not have permission to access this file.',
  );
};
