import { HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import * as crypto from 'crypto';
import { EmployeeInvitationStatus, MESSAGE_PATTERNS } from '@app/common';
import { EmployeeInvitationService } from './employee-invitation.service';

/**
 * Covers the security-relevant parts of handing an employee a login: that
 * only a hash of the token is stored, that a dead or reused link cannot be
 * redeemed, and that accepting binds the new account to the employee record
 * the portal resolves "me" through.
 */
describe('EmployeeInvitationService', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const EMPLOYEE = '22222222-2222-4222-8222-222222222222';
  const INVITATION = '33333333-3333-4333-8333-333333333333';
  const USER = '44444444-4444-4444-8444-444444444444';

  let invitationModel: any;
  let employeeModel: any;
  let lookupModel: any;
  let authClient: any;
  let userClient: any;
  let service: EmployeeInvitationService;

  const employee = (over: Record<string, any> = {}) => ({
    id: EMPLOYEE,
    tenantId: TENANT,
    employeeCode: 'TN-0024',
    firstName: 'Priya',
    lastName: 'Sharma',
    email: 'priya@technova.com',
    phone: null,
    userId: null,
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  const invitation = (over: Record<string, any> = {}) => ({
    id: INVITATION,
    tenantId: TENANT,
    employeeId: EMPLOYEE,
    email: 'priya@technova.com',
    tokenHash: 'hash',
    status: EmployeeInvitationStatus.PENDING,
    expiresAt: new Date(Date.now() + 86400000),
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    update: jest.fn().mockResolvedValue(undefined),
    ...over,
  });

  beforeEach(() => {
    invitationModel = {
      findOne: jest.fn().mockResolvedValue(null),
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async (values: any) => invitation(values)),
      update: jest.fn().mockResolvedValue([0]),
    };
    employeeModel = { findOne: jest.fn().mockResolvedValue(employee()) };
    lookupModel = {
      findOne: jest.fn().mockResolvedValue({ tenantId: TENANT }),
      create: jest.fn().mockResolvedValue(undefined),
    };

    authClient = { send: jest.fn().mockReturnValue(of({ credentialId: 'c1' })) };
    userClient = { send: jest.fn().mockReturnValue(of({ id: USER })) };

    const modelProvider = {
      getEmployeeInvitationModel: jest.fn().mockResolvedValue(invitationModel),
      getEmployeeModel: jest.fn().mockResolvedValue(employeeModel),
    };
    const tenantService = {
      getTenantById: jest.fn().mockResolvedValue({ organizationName: 'TechNova Solutions' }),
    };
    const config = { get: jest.fn().mockReturnValue('https://portal.technova.com') };

    service = new EmployeeInvitationService(
      lookupModel as any,
      modelProvider as any,
      tenantService as any,
      config as any,
      authClient as any,
      userClient as any,
    );
  });

  describe('invite', () => {
    it('stores only the hash of the token it emails', async () => {
      const result = await service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER);

      const stored = invitationModel.create.mock.calls[0][0];
      expect(stored.tokenHash).not.toBe(result.rawToken);
      expect(stored.tokenHash).toBe(
        crypto.createHash('sha256').update(result.rawToken).digest('hex'),
      );
      expect(stored).not.toHaveProperty('token');
    });

    it('puts the raw token in the link and nowhere else', async () => {
      const result = await service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER);

      expect(result.acceptUrl).toContain(encodeURIComponent(result.rawToken));
      expect(result.acceptUrl.startsWith('https://portal.technova.com/')).toBe(true);
    });

    it('never puts the tenant id in the link — the token alone resolves it server-side', async () => {
      const result = await service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER);

      expect(result.acceptUrl).not.toContain(TENANT);
      expect(lookupModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT }),
      );
    });

    it('revokes any earlier pending invitation so only the newest link works', async () => {
      await service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER);

      expect(invitationModel.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: EmployeeInvitationStatus.REVOKED }),
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT,
            employeeId: EMPLOYEE,
            status: EmployeeInvitationStatus.PENDING,
          }),
        }),
      );
    });

    it('refuses an employee who already has portal access', async () => {
      employeeModel.findOne.mockResolvedValue(employee({ userId: USER }));

      await expect(
        service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
      expect(invitationModel.create).not.toHaveBeenCalled();
    });

    it('refuses an employee from another organization', async () => {
      employeeModel.findOne.mockResolvedValue(null);

      await expect(
        service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(employeeModel.findOne).toHaveBeenCalledWith({
        where: { id: EMPLOYEE, tenantId: TENANT },
      });
    });

    it('refuses an employee with no address to write to', async () => {
      employeeModel.findOne.mockResolvedValue(employee({ email: null }));

      await expect(
        service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    });

    it('prefers an override address over the one on the record', async () => {
      await service.invite(
        TENANT,
        { employeeId: EMPLOYEE, email: 'priya.personal@gmail.com' } as any,
        USER,
      );

      expect(invitationModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'priya.personal@gmail.com' }),
      );
    });

    /** HR can resend; a mail outage must not lose the stored invitation. */
    it('keeps the invitation when the email cannot be sent', async () => {
      authClient.send.mockReturnValue(throwError(() => new Error('SMTP down')));

      await expect(
        service.invite(TENANT, { employeeId: EMPLOYEE } as any, USER),
      ).resolves.toMatchObject({ employeeId: EMPLOYEE });
    });
  });

  describe('revoke', () => {
    it('revokes a pending invitation', async () => {
      const row = invitation();
      invitationModel.findOne.mockResolvedValue(row);

      await service.revoke(TENANT, INVITATION);

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: EmployeeInvitationStatus.REVOKED }),
      );
    });

    it('refuses to revoke one that was already accepted', async () => {
      invitationModel.findOne.mockResolvedValue(
        invitation({ status: EmployeeInvitationStatus.ACCEPTED }),
      );

      await expect(service.revoke(TENANT, INVITATION)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });
  });

  describe('validate', () => {
    it('looks the token up by its hash, never by the raw value', async () => {
      invitationModel.findOne.mockResolvedValue(invitation());

      await service.validate('raw-token-value-long-enough');

      expect(invitationModel.findOne).toHaveBeenCalledWith({
        where: {
          tenantId: TENANT,
          tokenHash: crypto
            .createHash('sha256')
            .update('raw-token-value-long-enough')
            .digest('hex'),
        },
      });
    });

    it('rejects an unknown token', async () => {
      await expect(service.validate('nope')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('rejects a token that was already used', async () => {
      invitationModel.findOne.mockResolvedValue(
        invitation({ status: EmployeeInvitationStatus.ACCEPTED }),
      );

      await expect(service.validate('token')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('marks an out-of-date token expired rather than leaving it pending', async () => {
      const row = invitation({ expiresAt: new Date(Date.now() - 1000) });
      invitationModel.findOne.mockResolvedValue(row);

      await expect(service.validate('token')).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
      expect(row.update).toHaveBeenCalledWith({
        status: EmployeeInvitationStatus.EXPIRED,
      });
    });

    it('rejects a token no tenant lookup row points to', async () => {
      lookupModel.findOne.mockResolvedValue(null);

      await expect(service.validate('token')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
      expect(invitationModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('accept', () => {
    beforeEach(() => {
      invitationModel.findOne.mockResolvedValue(invitation());
    });

    it('refuses a mismatched confirmation before touching anything', async () => {
      await expect(
        service.accept({
          token: 'token',
          password: 'Secret@Pass2026',
          confirmPassword: 'Secret124',
        } as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(userClient.send).not.toHaveBeenCalled();
    });

    it('creates the account, the credential, and links them to the employee', async () => {
      const row = employee();
      employeeModel.findOne.mockResolvedValue(row);

      const result = await service.accept({
        token: 'token',
        password: 'Secret@Pass2026',
      } as any);

      expect(userClient.send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.USER.CREATE_USER,
        expect.objectContaining({ tenantId: TENANT, email: 'priya@technova.com' }),
      );
      expect(authClient.send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.AUTH.CREATE_ADMIN_CREDENTIAL,
        expect.objectContaining({ role: 'Employee', tenantId: TENANT }),
      );
      // The portal resolves the signed-in user to an employee through this.
      expect(row.update).toHaveBeenCalledWith({ userId: USER });
      expect(result.employeeId).toBe(EMPLOYEE);
    });

    it('forwards selected roleId to user creation and credential creation when invitation was accepted', async () => {
      const CUSTOM_ROLE_ID = '99999999-9999-4999-8999-999999999999';
      const row = invitation({ roleId: CUSTOM_ROLE_ID });
      invitationModel.findOne.mockResolvedValue(row);

      await service.accept({
        token: 'token',
        password: 'Secret@Pass2026',
      } as any);

      expect(userClient.send).toHaveBeenCalledWith(
        MESSAGE_PATTERNS.USER.CREATE_USER,
        expect.objectContaining({
          tenantId: TENANT,
          email: 'priya@technova.com',
          roleId: CUSTOM_ROLE_ID,
          roleIds: [CUSTOM_ROLE_ID],
        }),
      );
    });

    it('marks the invitation accepted so the link cannot be reused', async () => {
      const row = invitation();
      invitationModel.findOne.mockResolvedValue(row);

      await service.accept({ token: 'token', password: 'Secret@Pass2026' } as any);

      expect(row.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: EmployeeInvitationStatus.ACCEPTED }),
      );
    });

    it('does not mark it accepted when the account could not be created', async () => {
      const row = invitation();
      invitationModel.findOne.mockResolvedValue(row);
      userClient.send.mockReturnValue(throwError(() => new Error('user service down')));

      await expect(
        service.accept({ token: 'token', password: 'Secret@Pass2026' } as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(row.update).not.toHaveBeenCalled();
      expect(authClient.send).not.toHaveBeenCalled();
    });

    it('does not mark it accepted when the password could not be set', async () => {
      const row = invitation();
      invitationModel.findOne.mockResolvedValue(row);
      authClient.send.mockReturnValue(throwError(() => new Error('password reused')));

      await expect(
        service.accept({ token: 'token', password: 'Secret@Pass2026' } as any),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(row.update).not.toHaveBeenCalled();
    });

    it('refuses a password outside the policy before creating anything', async () => {
      const row = invitation();
      invitationModel.findOne.mockResolvedValue(row);

      for (const password of ['short', 'Secret123', 'Welcome#2026Pass']) {
        await expect(service.accept({ token: 'token', password } as any)).rejects.toMatchObject({
          status: HttpStatus.BAD_REQUEST,
        });
      }
      // No half-made account: user-service and auth-service were never called.
      expect(userClient.send).not.toHaveBeenCalled();
      expect(authClient.send).not.toHaveBeenCalled();
      expect(row.update).not.toHaveBeenCalled();
    });
  });
});
