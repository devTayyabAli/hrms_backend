import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { SecuritySettings } from '../models';
import { AllowedIpAddress } from '../models';
import { AddAllowedIpDto, UpdateSecuritySettingsDto } from '@app/common';
import { PlatformNotificationCategory } from '../models';
import { PlatformNotificationService } from './platform-notification.service';
import { describeChangedSettings } from './settings-change.util';

/**
 * Minimal IPv4 CIDR / exact-match check — no IPv6 CIDR support. Good enough
 * for the allowlist use case here (small, admin-curated list of office/VPN
 * ranges); a mismatched or unparseable entry never accidentally matches.
 */
/**
 * One spelling per address: IPv4 arriving over an IPv6 socket is reported as
 * "::ffff:203.0.113.25", which never equalled the "203.0.113.25" an
 * administrator types — so enabling the allowlist could shut everyone out.
 */
export function normalizeIp(ip: string): string {
  const value = (ip ?? '').trim().toLowerCase();
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Why an allowlist entry can't be used, or null. IPv4 may be an address or a CIDR; IPv6 an exact address. */
export function allowlistEntryProblem(entry: string): string | null {
  const value = entry.trim();
  if (value.includes('/')) {
    const [range, prefix] = value.split('/');
    if (!IPV4.test(range)) return 'CIDR ranges are supported for IPv4 only, e.g. 203.0.113.0/24.';
    if (!/^\d+$/.test(prefix) || Number(prefix) < 8 || Number(prefix) > 32) return 'A CIDR prefix must be between /8 and /32.';
    return null;
  }
  if (IPV4.test(value)) return null;
  if (value.includes(':') && IPV6.test(value)) return null;
  return 'Enter an IPv4 address (203.0.113.25), an IPv4 range (203.0.113.0/24) or an IPv6 address.';
}

function ipMatches(rawIp: string, rawEntry: string): boolean {
  const ip = normalizeIp(rawIp);
  const entry = normalizeIp(rawEntry);
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
    @Optional() private readonly platformNotifications?: PlatformNotificationService,
  ) {}

  /** Platform security policy changes go to every Super Admin, under Security alerts. */
  private announce(title: string, body: string) {
    void this.platformNotifications?.notify({
      category: PlatformNotificationCategory.SECURITY,
      title,
      body,
      url: '/system-management',
    });
  }

  /** Singleton row, created with defaults on first access. */
  async getOrCreate(): Promise<SecuritySettings> {
    const existing = await this.settingsModel.findOne();
    if (existing) return existing;
    return this.settingsModel.create({});
  }

  async getSecurity(): Promise<SecuritySettings> {
    return this.getOrCreate();
  }

  /**
   * Refuses a change that would leave the administrator making it unable to
   * reach the Super Admin portal: switching the allowlist on, or removing an
   * entry, while their own address isn't (or wouldn't be) covered.
   */
  private async assertCallerKeepsAccess(callerIp: string | undefined, entries: string[]) {
    if (!callerIp) return;
    if (entries.some((entry) => ipMatches(callerIp, entry))) return;
    throw new BadRequestException(
      `This would lock you out: your current IP address (${normalizeIp(callerIp)}) isn't on the allowlist. Add it first, then try again.`,
    );
  }

  async updateSecurity(dto: UpdateSecuritySettingsDto, callerIp?: string): Promise<SecuritySettings> {
    const settings = await this.getOrCreate();
    if (dto.ipWhitelistEnabled === true && !settings.ipWhitelistEnabled) {
      const entries = await this.allowedIpModel.findAll({ attributes: ['ipOrCidr'] });
      await this.assertCallerKeepsAccess(callerIp, entries.map((e) => e.ipOrCidr));
    }
    const changed = describeChangedSettings(settings.get({ plain: true }), dto);
    await settings.update(dto);
    if (changed) this.announce('Platform security settings changed', `Updated: ${changed}.`);
    return settings;
  }

  async listAllowedIps(): Promise<AllowedIpAddress[]> {
    return this.allowedIpModel.findAll({ order: [['createdAt', 'DESC']] });
  }

  async addAllowedIp(dto: AddAllowedIpDto): Promise<AllowedIpAddress> {
    const ipOrCidr = normalizeIp(dto.ipOrCidr);
    const problem = allowlistEntryProblem(ipOrCidr);
    if (problem) throw new BadRequestException(problem);
    dto = { ...dto, ipOrCidr };
    const existing = await this.allowedIpModel.findOne({ where: { ipOrCidr: dto.ipOrCidr } });
    if (existing) {
      throw new BadRequestException(`${dto.ipOrCidr} is already on the allowlist.`);
    }
    const created = await this.allowedIpModel.create({ ipOrCidr: dto.ipOrCidr });
    this.announce('IP added to the allowlist', `${dto.ipOrCidr} can now reach the Super Admin portal.`);
    return created;
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * `undefined` completes its observable without emitting, which surfaces at
   * the gateway as firstValueFrom's "no elements in sequence" error.
   */
  async removeAllowedIp(id: string, callerIp?: string): Promise<{ success: boolean }> {
    const entry = await this.allowedIpModel.findByPk(id);
    if (!entry) {
      throw new NotFoundException(`Allowed IP entry ${id} not found.`);
    }
    const settings = await this.getOrCreate();
    if (settings.ipWhitelistEnabled) {
      const remaining = (await this.allowedIpModel.findAll({ attributes: ['id', 'ipOrCidr'] }))
        .filter((e) => e.id !== id)
        .map((e) => e.ipOrCidr);
      await this.assertCallerKeepsAccess(callerIp, remaining);
    }
    await entry.destroy();
    this.announce('IP removed from the allowlist', `${entry.ipOrCidr} can no longer reach the Super Admin portal while the allowlist is on.`);
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
