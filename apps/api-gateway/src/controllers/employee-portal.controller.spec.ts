import { ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { MESSAGE_PATTERNS } from '@app/common';
import {
  EmployeePortalController,
  EmployeePortalReviewController,
} from './employee-portal.controller';

/**
 * The gateway half of My Documents: it is the only layer that can see both
 * the file store and the document rows, so it owns the checks that tie a
 * document to a file its owner actually uploaded, and the clean-up of stored
 * files when a document goes away.
 */
describe('EmployeePortalController documents', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const USER = '22222222-2222-4222-8222-222222222222';
  const EMAIL = 'meera@technova.com';

  let tenantSend: jest.Mock;
  let authSend: jest.Mock;
  let controller: EmployeePortalController;

  const storedFile = (over: Record<string, any> = {}) => ({
    success: true,
    data: {
      id: 'file-1',
      uploadedBy: USER,
      originalName: 'passport.pdf',
      mimeType: 'application/pdf',
      size: 4096,
      ...over,
    },
  });

  beforeEach(() => {
    tenantSend = jest.fn().mockReturnValue(of({ id: 'doc1' }));
    authSend = jest.fn().mockReturnValue(of({ success: true }));
    controller = new EmployeePortalController(
      { send: tenantSend } as any,
      { send: authSend } as any,
    );
  });

  it('refuses to attach a file someone else uploaded', async () => {
    authSend.mockReturnValue(of(storedFile({ uploadedBy: 'someone-else' })));

    await expect(
      controller.uploadDocument(TENANT, USER, EMAIL, {
        title: 'Passport',
        category: 'IDENTITY',
        fileId: 'file-1',
      } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenantSend).not.toHaveBeenCalled();
  });

  it('takes the file name, size and type from the file store, not the client', async () => {
    authSend.mockReturnValue(of(storedFile()));

    await controller.uploadDocument(TENANT, USER, EMAIL, {
      title: 'Passport',
      category: 'IDENTITY',
      fileId: 'file-1',
      fileName: 'innocent.txt',
      sizeBytes: 1,
    } as any);

    expect(tenantSend).toHaveBeenCalledWith(
      MESSAGE_PATTERNS.EMPLOYEE_PORTAL.UPLOAD_DOCUMENT,
      {
        tenantId: TENANT,
        userId: USER,
        email: EMAIL,
        dto: expect.objectContaining({
          fileName: 'passport.pdf',
          sizeBytes: 4096,
          mimeType: 'application/pdf',
        }),
      },
    );
  });

  it('stores a one-step upload privately and records it as the uploader', async () => {
    authSend.mockReturnValue(of(storedFile()));
    tenantSend.mockReturnValue(of({ id: 'doc1', status: 'PENDING' }));

    const result = await controller.uploadDocumentFile(
      TENANT,
      USER,
      EMAIL,
      {
        buffer: Buffer.from('x'),
        originalname: 'passport.pdf',
        mimetype: 'application/pdf',
        size: 1,
      } as any,
      { title: 'Passport', category: 'IDENTITY' } as any,
    );

    expect(authSend).toHaveBeenCalledWith(
      MESSAGE_PATTERNS.FILE.UPLOAD_FILE,
      expect.objectContaining({
        tenantId: TENANT,
        uploadedBy: USER,
        isPublic: false,
      }),
    );
    expect(result).toMatchObject({ id: 'doc1' });
  });

  it('deletes the stored file again when the document is refused', async () => {
    authSend
      .mockReturnValueOnce(of(storedFile())) // UPLOAD_FILE
      .mockReturnValueOnce(of({ success: true })); // DELETE_FILE
    tenantSend.mockReturnValue(throwError(() => new Error('already attached')));

    await expect(
      controller.uploadDocumentFile(
        TENANT,
        USER,
        EMAIL,
        {
          buffer: Buffer.from('x'),
          originalname: 'a.pdf',
          mimetype: 'application/pdf',
          size: 1,
        } as any,
        { title: 'Passport', category: 'IDENTITY' } as any,
      ),
    ).rejects.toThrow('already attached');
    expect(authSend).toHaveBeenLastCalledWith(
      MESSAGE_PATTERNS.FILE.DELETE_FILE,
      {
        fileId: 'file-1',
        userTenantId: TENANT,
      },
    );
  });

  it('removes the stored file along with the document', async () => {
    tenantSend.mockReturnValue(
      of({ message: 'Document deleted successfully', fileId: 'file-1' }),
    );

    const result = await controller.deleteDocument(TENANT, USER, EMAIL, 'doc1');

    expect(authSend).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.DELETE_FILE, {
      fileId: 'file-1',
      userTenantId: TENANT,
    });
    expect(result).toEqual({ message: 'Document deleted successfully' });
  });

  it('still reports a deletion when the stored file cannot be removed', async () => {
    tenantSend.mockReturnValue(
      of({ message: 'Document deleted successfully', fileId: 'file-1' }),
    );
    authSend.mockReturnValue(throwError(() => new Error('storage down')));

    await expect(
      controller.deleteDocument(TENANT, USER, EMAIL, 'doc1'),
    ).resolves.toEqual({
      message: 'Document deleted successfully',
    });
  });

  it('checks a replacement file and cleans up the one it replaced', async () => {
    authSend.mockReturnValue(of(storedFile({ id: 'file-2' })));
    tenantSend.mockReturnValue(
      of({ id: 'doc1', status: 'PENDING', replacedFileId: 'file-1' }),
    );

    const result = await controller.updateDocument(
      TENANT,
      USER,
      EMAIL,
      'doc1',
      { fileId: 'file-2' } as any,
    );

    expect(authSend).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.GET_METADATA, {
      fileId: 'file-2',
      userTenantId: TENANT,
    });
    expect(authSend).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.DELETE_FILE, {
      fileId: 'file-1',
      userTenantId: TENANT,
    });
    expect(result).toEqual({ id: 'doc1', status: 'PENDING' });
  });

  it('only streams the file behind a document the caller owns', async () => {
    tenantSend.mockReturnValue(of({ id: 'doc1', fileId: 'file-9' }));
    authSend.mockReturnValue(
      of({
        buffer: Buffer.from('pdf'),
        mimeType: 'application/pdf',
        originalName: 'p.pdf',
      }),
    );
    const res: any = {
      setHeader: jest.fn(),
      send: jest.fn(),
      status: jest.fn(),
    };

    await controller.downloadDocument(TENANT, USER, EMAIL, 'doc1', res);

    expect(tenantSend).toHaveBeenCalledWith(
      MESSAGE_PATTERNS.EMPLOYEE_PORTAL.GET_DOCUMENT,
      {
        tenantId: TENANT,
        userId: USER,
        email: EMAIL,
        documentId: 'doc1',
      },
    );
    expect(authSend).toHaveBeenCalledWith(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, {
      fileId: 'file-9',
      userTenantId: TENANT,
    });
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'inline; filename="p.pdf"',
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Content-Type-Options',
      'nosniff',
    );
  });
});

describe('EmployeePortalReviewController documents', () => {
  it('records the reviewing HR user on a decision', async () => {
    const tenantSend = jest.fn().mockReturnValue(of({}));
    const controller = new EmployeePortalReviewController(
      { send: tenantSend } as any,
      { send: jest.fn() } as any,
    );

    controller.reviewDocument('t1', 'hr-user', 'hr@x.com', 'doc1', {
      status: 'REJECTED',
      note: 'Blurry',
    } as any);

    expect(tenantSend).toHaveBeenCalledWith(
      MESSAGE_PATTERNS.EMPLOYEE_PORTAL.REVIEW_DOCUMENT,
      {
        tenantId: 't1',
        documentId: 'doc1',
        actorUserId: 'hr-user',
        actorEmail: 'hr@x.com',
        dto: { status: 'REJECTED', note: 'Blurry' },
      },
    );
  });
});
