import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { SecuritySettings } from '../models';
import { AllowedIpAddress } from '../models';
import { AddAllowedIpDto, UpdateSecuritySettingsDto } from '@app/common';

/**
 * Minimal IPv4 CIDR / exact-match check — no IPv6 CIDR support. Good enough
 * for the allowlist use case here (small, admin-curated list of office/VPN
 * ranges); a mismatched or unparseable entry never accidentally matches.
 */
function ipMatches(ip: string, entry: string): boolean {
  if (!entry.includes('/')) {
    return ip === entry;
  }

  const [range, prefixStr] = entry.split('/');
  const prefix = Number(prefixStr);
  const toInt = (addr: string): number | null => {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
    return parts.reduce((acc, p) => (acc << 8) + p, 0) >>> 0;
  };

  const ipInt = toInt(ip);
  const rangeInt = toInt(range);
  if (ipInt === null || rangeInt === null || prefix < 0 || prefix > 32) return false;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

@Injectable()
export class SecuritySettingsService {
  constructor(
    @InjectModel(SecuritySettings) private readonly settingsModel: typeof SecuritySettings,
    @InjectModel(AllowedIpAddress) private readonly allowedIpModel: typeof AllowedIpAddress,
  ) {}

  /** Singleton row, created with defaults on first access. */
  async getOrCreate(): Promise<SecuritySettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) return existing;
    return this.settingsModel.create({});
  }

  async getSecurity(): Promise<SecuritySettings> {
    return this.getOrCreate();
  }

  async updateSecurity(dto: UpdateSecuritySettingsDto): Promise<SecuritySettings> {
    const settings = await this.getOrCreate();
    await settings.update(dto);
    return settings;
  }

  async listAllowedIps(): Promise<AllowedIpAddress[]> {
    return this.allowedIpModel.findAll({ order: [['createdAt', 'DESC']] });
  }

  async addAllowedIp(dto: AddAllowedIpDto): Promise<AllowedIpAddress> {
    const existing = await this.allowedIpModel.findOne({ where: { ipOrCidr: dto.ipOrCidr } });
    if (existing) {
      throw new BadRequestException(`${dto.ipOrCidr} is already on the allowlist.`);
    }
    return this.allowedIpModel.create({ ipOrCidr: dto.ipOrCidr });
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * `undefined` completes its observable without emitting, which surfaces at
   * the gateway as firstValueFrom's "no elements in sequence" error.
   */
  async removeAllowedIp(id: string): Promise<{ success: boolean }> {
    const entry = await this.allowedIpModel.findByPk(id);
    if (!entry) {
      throw new NotFoundException(`Allowed IP entry ${id} not found.`);
    }
    await entry.destroy();
    return { success: true };
  }

  /**
   * Real enforcement point for IpAllowlistGuard (called over RPC from the
   * gateway, once per request to a guarded route). Whitelisting disabled ⇒
   * always allowed; enabled with an empty list ⇒ nothing is allowed (an
   * admin must add at least their own IP before this can lock anyone out
   * usefully — the gateway guard surfaces a clear 403 either way).
   */
  async isIpAllowed(ip: string): Promise<boolean> {
    return (await this.evaluateIp(ip)).allowed;
  }

  /**
   * As `isIpAllowed`, but also reports whether the allowlist is switched on.
   *
   * The gateway guard needs that second bit to decide what to do when this
   * service is unreachable. "Allowed" alone is ambiguous: it is the answer
   * both when the caller's IP is on the list and when there is no list at
   * all, so a guard holding only that cannot tell whether failing open would
   * be a no-op or would disable a control an administrator deliberately
   * enabled.
   */
  async evaluateIp(ip: string): Promise<{ allowed: boolean; enforcing: boolean }> {
    const settings = await this.getOrCreate();
    if (!settings.ipWhitelistEnabled) {
      return { allowed: true, enforcing: false };
    }

    const entries = await this.allowedIpModel.findAll();
    return {
      allowed: entries.some((entry) => ipMatches(ip, entry.ipOrCidr)),
      enforcing: true,
    };
  }
}
