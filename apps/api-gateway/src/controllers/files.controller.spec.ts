import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { of } from 'rxjs';
import { MESSAGE_PATTERNS } from '@app/common';
import { FilesController } from './files.controller';

/**
 * Covers upload validation and RPC payload mapping, plus the hardening on the
 * two file-serving routes: `nosniff` on every response, and inline rendering
 * restricted to types a browser cannot be talked into executing.
 */
describe('FilesController', () => {
  let controller: FilesController;
  let send: jest.Mock;
  let res: {
    setHeader: jest.Mock;
    send: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
  };

  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const employee = {
    id: USER,
    tenantId: TENANT,
    permissions: ['attendance.view'],
  };
  const superAdmin = { id: 'sa-1', isSuperAdmin: true, roles: ['superadmin'] };
  /** GET_METADATA answers with this record, then the real call answers with `then`. */
  const metaThen = (meta: Record<string, unknown>, then: unknown) =>
    send
      .mockReturnValueOnce(
        of({
          data: {
            tenantId: TENANT,
            uploadedBy: USER,
            category: 'employee-document',
            storageKey: 'k',
            ...meta,
          },
        }),
      )
      .mockReturnValueOnce(of(then));

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ ok: true }));
    controller = new FilesController({ send } as any);
    res = {
      setHeader: jest.fn(),
      send: jest.fn((body) => body),
      status: jest.fn().mockReturnThis(),
      json: jest.fn((body) => body),
    };
  });

  const multerFile = (over: Partial<Express.Multer.File> = {}) =>
    ({
      buffer: Buffer.from('hello'),
      originalname: 'cv.pdf',
      mimetype: 'application/pdf',
      size: 5,
      ...over,
    }) as Express.Multer.File;

  describe('upload', () => {
    it('rejects a request with no multipart file', async () => {
      await expect(
        controller.uploadFile(undefined as any, {} as any, employee),
      ).rejects.toThrow(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });

    it('maps file metadata and ownership into the RPC payload', async () => {
      await controller.uploadFile(
        multerFile(),
        {
          category: 'documents',
          entityType: 'Employee',
          entityId: 'e-1',
          isPublic: false,
        } as any,
        employee,
      );

      expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.UPLOAD_FILE, {
        file: {
          buffer: expect.any(Buffer),
          originalname: 'cv.pdf',
          mimetype: 'application/pdf',
          size: 5,
        },
        tenantId: TENANT,
        uploadedBy: USER,
        category: 'documents',
        entityType: 'Employee',
        entityId: 'e-1',
        isPublic: false,
      });
    });

    it('files a Super Admin upload under platform with the general category', async () => {
      await controller.uploadFile(multerFile(), {} as any, superAdmin);
      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.FILE.UPLOAD_FILE,
        expect.objectContaining({
          tenantId: 'platform',
          uploadedBy: 'sa-1',
          category: 'general',
        }),
      );
    });

    it('never takes the tenant from anywhere but the JWT', async () => {
      await controller.uploadFile(multerFile(), {} as any, {
        ...employee,
        tenantId: OTHER,
      });
      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.FILE.UPLOAD_FILE,
        expect.objectContaining({ tenantId: OTHER }),
      );
    });

    it('refuses a tenant user with no organization, and reserved categories', async () => {
      await expect(
        controller.uploadFile(multerFile(), {} as any, { id: USER }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        controller.uploadFile(
          multerFile(),
          { category: 'backups' } as any,
          employee,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('public download', () => {
    const publicResult = (mimeType: string) => ({
      buffer: Buffer.from('x'),
      mimeType,
      originalName: 'logo.png',
    });

    it('always sets nosniff', async () => {
      send.mockReturnValue(of(publicResult('image/png')));

      await controller.downloadPublicFile('f-1', res as any);

      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff',
      );
    });

    it.each([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/pdf',
    ])('renders %s inline', async (mimeType) => {
      send.mockReturnValue(of(publicResult(mimeType)));

      await controller.downloadPublicFile('f-1', res as any);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'inline; filename="logo.png"',
      );
    });

    it.each(['text/html', 'image/svg+xml', 'text/plain', 'application/json'])(
      'forces %s to download instead of rendering it on this origin',
      async (mimeType) => {
        send.mockReturnValue(of(publicResult(mimeType)));

        await controller.downloadPublicFile('f-1', res as any);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Content-Disposition',
          'attachment; filename="logo.png"',
        );
      },
    );

    it('strips quotes from a filename so it cannot break out of the header', async () => {
      send.mockReturnValue(
        of({
          buffer: Buffer.from('x'),
          mimeType: 'image/png',
          originalName: 'a".png',
        }),
      );

      await controller.downloadPublicFile('f-1', res as any);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'inline; filename="a.png"',
      );
    });

    it('404s when the service returns no buffer', async () => {
      send.mockReturnValue(of({}));

      await controller.downloadPublicFile('f-1', res as any);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        message: 'File stream unavailable.',
      });
    });
  });

  describe('authenticated download', () => {
    it('serves as an attachment even for an inline-safe type', async () => {
      metaThen(
        {},
        {
          buffer: Buffer.from('x'),
          mimeType: 'image/png',
          originalName: 'chart.png',
        },
      );

      await controller.downloadFile('f-1', employee, res as any);

      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="chart.png"',
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Content-Type-Options',
        'nosniff',
      );
    });

    it('scopes the lookup by the caller tenant', async () => {
      metaThen({}, { buffer: Buffer.from('x') });
      await controller.downloadFile('f-1', employee, res as any);
      expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
        fileId: 'f-1',
        userTenantId: TENANT,
      });
    });

    it("refuses a colleague's private file", async () => {
      metaThen({ uploadedBy: OTHER }, { buffer: Buffer.from('x') });
      await expect(
        controller.downloadFile('f-1', employee, res as any),
      ).rejects.toThrow(ForbiddenException);
      expect(send).not.toHaveBeenCalledWith(
        MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE,
        expect.anything(),
      );
    });

    it('hides platform files (backups) and other tenants from tenant users', async () => {
      metaThen({ tenantId: 'platform', category: 'backups' }, {});
      await expect(
        controller.downloadFile('f-1', employee, res as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets a category permission holder read company documents, and an org admin read anything', async () => {
      metaThen(
        { uploadedBy: OTHER, category: 'documents' },
        { buffer: Buffer.from('x') },
      );
      await controller.downloadFile(
        'f-1',
        { ...employee, permissions: ['documents.view'] },
        res as any,
      );
      metaThen({ uploadedBy: OTHER }, { buffer: Buffer.from('x') });
      await controller.downloadFile(
        'f-1',
        { ...employee, isFullAccess: true },
        res as any,
      );
      expect(res.send).toHaveBeenCalledTimes(2);
    });

    it('lets the Super Admin reach any file through the platform scope', async () => {
      metaThen(
        { tenantId: TENANT, uploadedBy: OTHER },
        { buffer: Buffer.from('x') },
      );
      await controller.downloadFile('f-1', superAdmin, res as any);
      expect(send).toHaveBeenNthCalledWith(
        1,
        MESSAGE_PATTERNS.FILE.GET_METADATA,
        { fileId: 'f-1', userTenantId: 'platform' },
      );
    });
  });

  describe('listing and deleting', () => {
    it('lists files only for an administrator', () => {
      expect(() => controller.queryFiles({} as any, employee)).toThrow(
        ForbiddenException,
      );
      controller.queryFiles({ category: 'documents' } as any, {
        ...employee,
        isFullAccess: true,
      });
      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.FILE.QUERY_FILES,
        expect.objectContaining({ tenantId: TENANT }),
      );
    });

    it('deletes only your own file unless you hold the category permission', async () => {
      metaThen({ uploadedBy: OTHER, category: 'documents' }, { success: true });
      await expect(controller.deleteFile('f-1', employee)).rejects.toThrow(
        ForbiddenException,
      );
      send.mockReset();
      metaThen({}, { success: true });
      await expect(controller.deleteFile('f-1', employee)).resolves.toEqual({
        success: true,
      });
    });
  });
});
