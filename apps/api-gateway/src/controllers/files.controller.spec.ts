import { BadRequestException } from '@nestjs/common';
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
        controller.uploadFile(undefined as any, {} as any, USER, TENANT),
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
        USER,
        TENANT,
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

    it('falls back to platform/system/general when tenant, user and category are absent', async () => {
      await controller.uploadFile(
        multerFile(),
        {} as any,
        undefined as any,
        undefined as any,
      );

      expect(send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.FILE.UPLOAD_FILE,
        expect.objectContaining({
          tenantId: 'platform',
          uploadedBy: 'system',
          category: 'general',
        }),
      );
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
      send.mockReturnValue(
        of({
          buffer: Buffer.from('x'),
          mimeType: 'image/png',
          originalName: 'chart.png',
        }),
      );

      await controller.downloadFile('f-1', TENANT, res as any);

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
      send.mockReturnValue(of({ buffer: Buffer.from('x') }));

      await controller.downloadFile('f-1', TENANT, res as any);

      expect(send).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
        fileId: 'f-1',
        userTenantId: TENANT,
      });
    });
  });
});
