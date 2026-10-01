import { BadRequestException } from '@nestjs/common';
import { OtpService } from './otp.service';

/**
 * Cover for the password-reset OTP round trip.
 *
 * The audited defect was at the call site, not here: `forgotPassword` never
 * awaited `generateOtp()` and stored the resulting Promise into a string
 * column, so the persisted value was "[object Promise]" and no submitted code
 * could ever match it — password reset was inoperable for every account,
 * silently. These tests pin the contract that call site now depends on: the
 * returned record is resolved, the plaintext and hash are distinct, and the
 * hash verifies only against the code it was derived from.
 */
describe('OtpService', () => {
  let service: OtpService;

  beforeEach(() => {
    service = new OtpService();
  });

  describe('generateOtp', () => {
    it('resolves to a record rather than a pending promise', async () => {
      const record = await service.generateOtp();
      // A bare `generateOtp()` is a Promise; anything that stringifies it
      // yields "[object Promise]", which is precisely the bug.
      expect(String(record)).not.toContain('Promise');
      expect(record).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          hashedCode: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );
    });

    it('produces a six-digit numeric code', async () => {
      const { code } = await service.generateOtp();
      expect(code).toMatch(/^\d{6}$/);
    });

    it('never returns the plaintext code as its stored hash', async () => {
      const { code, hashedCode } = await service.generateOtp();
      expect(hashedCode).not.toBe(code);
      expect(hashedCode).not.toContain(code);
      expect(hashedCode.startsWith('$2')).toBe(true);
    });

    it('expires roughly ten minutes out', async () => {
      const { expiresAt } = await service.generateOtp();
      const deltaMs = expiresAt.getTime() - Date.now();
      expect(deltaMs).toBeGreaterThan(9 * 60 * 1000);
      expect(deltaMs).toBeLessThanOrEqual(10 * 60 * 1000);
    });

    it('stays within range and varies across many draws', async () => {
      // Guards the crypto.randomInt bounds: randomInt's max is exclusive, so
      // an off-by-one here would emit 1000000 or never emit 999999.
      const codes = await Promise.all(
        Array.from({ length: 40 }, () => service.generateOtp()),
      );
      for (const { code } of codes) {
        const n = Number(code);
        expect(n).toBeGreaterThanOrEqual(100000);
        expect(n).toBeLessThanOrEqual(999999);
      }
      // Not a randomness test — just catches a constant or a stuck generator.
      expect(new Set(codes.map((c) => c.code)).size).toBeGreaterThan(1);
    });
  });

  describe('verifyOtp', () => {
    it('accepts the code its hash was derived from', async () => {
      const { code, hashedCode, expiresAt } = await service.generateOtp();
      await expect(
        service.verifyOtp(code, hashedCode, expiresAt),
      ).resolves.toBe(true);
    });

    // Note the contract: this method signals failure by throwing, and only
    // ever returns `true`. The boolean return is therefore decorative — which
    // is exactly why the old `target.resetOtp !== dto.otp` call site looked
    // reasonable and silently bypassed all of it.
    it('rejects a different code', async () => {
      const { code, hashedCode, expiresAt } = await service.generateOtp();
      const wrong = code === '123456' ? '654321' : '123456';
      await expect(
        service.verifyOtp(wrong, hashedCode, expiresAt),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects the stored hash submitted as the code', async () => {
      // If a hash ever leaked, replaying it must not authenticate.
      const { hashedCode, expiresAt } = await service.generateOtp();
      await expect(
        service.verifyOtp(hashedCode, hashedCode, expiresAt),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses an expired code', async () => {
      const { code, hashedCode } = await service.generateOtp();
      const expired = new Date(Date.now() - 1000);
      await expect(
        service.verifyOtp(code, hashedCode, expired),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses when no code is on file', async () => {
      await expect(
        service.verifyOtp('123456', '', new Date(Date.now() + 60000)),
      ).rejects.toThrow(BadRequestException);

      await expect(service.verifyOtp('123456', 'hash', null)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
