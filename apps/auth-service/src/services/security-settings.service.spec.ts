import { BadRequestException } from '@nestjs/common';
import { SecuritySettingsService, allowlistEntryProblem, normalizeIp } from './security-settings.service';

const setup = (enabled: boolean, entries: string[]) => {
  const settings: any = {
    ipWhitelistEnabled: enabled,
    update: jest.fn(async (patch: any) => Object.assign(settings, patch)),
    get: () => ({ ipWhitelistEnabled: settings.ipWhitelistEnabled }),
  };
  const rows = entries.map((ipOrCidr, i) => ({ id: `ip${i}`, ipOrCidr, destroy: jest.fn() }));
  const service = new SecuritySettingsService(
    { findOne: async () => settings, create: async () => settings } as any,
    {
      findAll: async () => rows,
      findByPk: async (id: string) => rows.find((r) => r.id === id) ?? null,
      findOne: async () => null,
      create: async (v: any) => v,
    } as any,
  );
  return { service, settings, rows };
};

describe('SecuritySettingsService — IP allowlist', () => {
  it('reads IPv4 delivered over IPv6 the way an admin writes it', () => {
    expect(normalizeIp('::ffff:203.0.113.25')).toBe('203.0.113.25');
    expect(normalizeIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
  });

  it('matches mapped addresses and CIDR ranges', async () => {
    const { service } = setup(true, ['203.0.113.0/24']);
    await expect(service.evaluateIp('::ffff:203.0.113.25')).resolves.toEqual({ allowed: true, enforcing: true });
    await expect(service.evaluateIp('198.51.100.1')).resolves.toEqual({ allowed: false, enforcing: true });
  });

  it('validates entries', () => {
    expect(allowlistEntryProblem('203.0.113.25')).toBeNull();
    expect(allowlistEntryProblem('203.0.113.0/24')).toBeNull();
    expect(allowlistEntryProblem('2001:db8::1')).toBeNull();
    expect(allowlistEntryProblem('203.0.113.300')).toMatch(/IPv4/);
    expect(allowlistEntryProblem('203.0.113.0/4')).toMatch(/\/8 and \/32/);
    expect(allowlistEntryProblem('localhost')).toMatch(/IPv4/);
  });

  it('refuses to switch the allowlist on when it would lock the caller out', async () => {
    const { service, settings } = setup(false, ['198.51.100.7']);
    await expect(service.updateSecurity({ ipWhitelistEnabled: true }, '::ffff:203.0.113.25')).rejects.toBeInstanceOf(BadRequestException);
    expect(settings.ipWhitelistEnabled).toBe(false);
    await expect(service.updateSecurity({ ipWhitelistEnabled: true }, '198.51.100.7')).resolves.toBeTruthy();
    expect(settings.ipWhitelistEnabled).toBe(true);
  });

  it("refuses to remove the entry the caller depends on while it's enforcing", async () => {
    const { service, rows } = setup(true, ['203.0.113.25', '198.51.100.7']);
    await expect(service.removeAllowedIp('ip0', '203.0.113.25')).rejects.toBeInstanceOf(BadRequestException);
    expect(rows[0].destroy).not.toHaveBeenCalled();
    await expect(service.removeAllowedIp('ip1', '203.0.113.25')).resolves.toEqual({ success: true });
  });
});
