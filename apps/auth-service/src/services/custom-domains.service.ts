import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { PlatformDomain } from '../models';
import { AddDomainDto, UpdateDomainDto } from '@app/common';

/**
 * CRUD registry for platform custom domains. `sslEnabled`/`redirectHttpToHttps`
 * are stored preferences only — see PlatformDomain model comment. No
 * certificate is ever issued and no reverse-proxy/DNS record is created.
 */
@Injectable()
export class CustomDomainsService {
  constructor(@InjectModel(PlatformDomain) private readonly domainModel: typeof PlatformDomain) {}

  async list(): Promise<PlatformDomain[]> {
    return this.domainModel.findAll({ order: [['createdAt', 'DESC']] });
  }

  async add(dto: AddDomainDto): Promise<PlatformDomain> {
    const existing = await this.domainModel.findOne({ where: { domain: dto.domain } });
    if (existing) {
      throw new BadRequestException(`${dto.domain} is already configured.`);
    }
    return this.domainModel.create({ domain: dto.domain, status: dto.status });
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
}
