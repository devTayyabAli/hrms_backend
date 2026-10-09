import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/sequelize';
import { promises as dns } from 'dns';
import * as tls from 'tls';
import { PlatformDomain } from '../models';
import { AddDomainDto, UpdateDomainDto } from '@app/common';

export type DnsStatus = 'pending' | 'verified' | 'misconfigured';
export type SslStatus = 'pending' | 'valid' | 'expiring' | 'invalid';

/** Re-checked this often, so an expiring certificate or a changed record shows up on its own. */
const RECHECK_MS = 6 * 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 8_000;
/** A certificate expiring sooner than this is flagged. */
const EXPIRY_WARNING_DAYS = 14;

const withTimeout = <T>(promise: Promise<T>, ms = LOOKUP_TIMEOUT_MS): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

const hostOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * Custom domains for the platform: each one is checked for real — its DNS
 * must point at the platform, and the certificate it serves over HTTPS must
 * be valid. Issuing the certificate and routing the domain stay with the
 * hosting provider (Vercel or the reverse proxy); this verifies that both
 * were done, and keeps verifying.
 *
 * The expected DNS target is `PLATFORM_DOMAIN_TARGET` (the CNAME the hosting
 * provider asks for, e.g. cname.vercel-dns.com), else the host of
 * FRONTEND_URL.
 */
@Injectable()
export class CustomDomainsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomDomainsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(PlatformDomain) private readonly domainModel: typeof PlatformDomain,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.verifyAll(), RECHECK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Where custom domains must point, and the platform's own (primary) domain. */
  configuration() {
    const primary = hostOf(this.config.get<string>('FRONTEND_URL'));
    const target = (this.config.get<string>('PLATFORM_DOMAIN_TARGET') || primary || '').trim().toLowerCase() || null;
    return { primaryDomain: primary, target };
  }

  async list() {
    const domains = await this.domainModel.findAll({ order: [['createdAt', 'DESC']] });
    return { ...this.configuration(), domains };
  }

  async add(dto: AddDomainDto): Promise<PlatformDomain> {
    const name = dto.domain.trim().toLowerCase().replace(/\.$/, '');
    const { primaryDomain } = this.configuration();
    if (name === primaryDomain) throw new BadRequestException(`${name} is already the platform's primary domain.`);
    const existing = await this.domainModel.findOne({ where: { domain: name } });
    if (existing) {
      throw new BadRequestException(`${name} is already configured.`);
    }
    const domain = await this.domainModel.create({ domain: name, status: dto.status });
    return this.verify(domain.id);
  }

  async update(id: string, dto: UpdateDomainDto): Promise<PlatformDomain> {
    const domain = await this.domainModel.findByPk(id);
    if (!domain) {
      throw new NotFoundException(`Domain ${id} not found.`);
    }
    await domain.update(dto);
    return domain;
  }

  /**
   * Returns a body rather than void: an RPC handler that resolves to
   * `undefined` completes its observable without emitting, which surfaces at
   * the gateway as firstValueFrom's "no elements in sequence" error.
   */
  async remove(id: string): Promise<{ success: boolean }> {
    const domain = await this.domainModel.findByPk(id);
    if (!domain) {
      throw new NotFoundException(`Domain ${id} not found.`);
    }
    await domain.destroy();
    return { success: true };
  }

  async verifyAll(): Promise<void> {
    const domains = await this.domainModel.findAll({ attributes: ['id'] }).catch(() => []);
    for (const { id } of domains) {
      await this.verify(id).catch((error) => this.logger.warn(`Domain check ${id} failed: ${error?.message ?? error}`));
    }
  }

  /** Checks one domain's DNS and certificate now and stores the result. */
  async verify(id: string): Promise<PlatformDomain> {
    const domain = await this.domainModel.findByPk(id);
    if (!domain) throw new NotFoundException(`Domain ${id} not found.`);
    const [dnsResult, sslResult] = await Promise.all([this.checkDns(domain.domain), this.checkCertificate(domain.domain)]);
    await domain.update({
      dnsStatus: dnsResult.status,
      dnsDetail: dnsResult.detail,
      sslStatus: sslResult.status,
      sslDetail: sslResult.detail,
      sslIssuer: sslResult.issuer,
      sslExpiresAt: sslResult.expiresAt,
      lastCheckedAt: new Date(),
      sslEnabled: sslResult.status === 'valid' || sslResult.status === 'expiring',
    });
    return domain;
  }

  private async checkDns(name: string): Promise<{ status: DnsStatus; detail: string }> {
    const { target } = this.configuration();
    if (!target) return { status: 'pending', detail: 'No DNS target configured: set PLATFORM_DOMAIN_TARGET or FRONTEND_URL.' };

    const cnames = await withTimeout(dns.resolveCname(name)).catch(() => [] as string[]);
    if (cnames.some((c) => c.toLowerCase().replace(/\.$/, '') === target)) {
      return { status: 'verified', detail: `CNAME points to ${target}.` };
    }
    // An apex domain can't hold a CNAME; matching addresses count as pointing at the platform.
    const [own, expected] = await Promise.all([
      withTimeout(dns.resolve4(name)).catch(() => [] as string[]),
      withTimeout(dns.resolve4(target)).catch(() => [] as string[]),
    ]);
    if (own.length && own.some((ip) => expected.includes(ip))) {
      return { status: 'verified', detail: `Resolves to the platform (${own.join(', ')}).` };
    }
    if (!cnames.length && !own.length) {
      return { status: 'pending', detail: `No DNS record yet. Add a CNAME record pointing to ${target}.` };
    }
    const pointsTo = cnames[0] ?? own.join(', ');
    return { status: 'misconfigured', detail: `Points to ${pointsTo}, not ${target}. Change the record to a CNAME for ${target}.` };
  }

  private checkCertificate(
    name: string,
  ): Promise<{ status: SslStatus; detail: string; issuer: string | null; expiresAt: Date | null }> {
    return new Promise((resolve) => {
      const done = (value: { status: SslStatus; detail: string; issuer: string | null; expiresAt: Date | null }) => {
        socket.destroy();
        resolve(value);
      };
      const socket = tls.connect({ host: name, port: 443, servername: name, timeout: LOOKUP_TIMEOUT_MS, rejectUnauthorized: false });
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        const expiresAt = cert?.valid_to ? new Date(cert.valid_to) : null;
        const issuer = (cert?.issuer?.O as string) || (cert?.issuer?.CN as string) || null;
        if (!socket.authorized) {
          return done({ status: 'invalid', detail: `Certificate not trusted: ${String(socket.authorizationError ?? 'unknown reason')}.`, issuer, expiresAt });
        }
        const daysLeft = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
        if (daysLeft !== null && daysLeft < EXPIRY_WARNING_DAYS) {
          return done({ status: 'expiring', detail: `Certificate expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`, issuer, expiresAt });
        }
        done({ status: 'valid', detail: issuer ? `Issued by ${issuer}.` : 'Valid certificate.', issuer, expiresAt });
      });
      socket.once('timeout', () => done({ status: 'pending', detail: 'No HTTPS response yet.', issuer: null, expiresAt: null }));
      socket.once('error', (error: any) =>
        done({ status: 'pending', detail: `No HTTPS response yet (${error?.code ?? error?.message ?? 'error'}).`, issuer: null, expiresAt: null }),
      );
    });
  }
}
