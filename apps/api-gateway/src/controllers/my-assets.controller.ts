import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import {
  AcceptAssetHandoverDto,
  CreateAssetRequestDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * My Assets (employee portal): the equipment the signed-in employee has been
 * given, signing for it, and asking IT / Admin for a repair or replacement.
 *
 * Like the rest of `organization/me`, everything is the caller's own — the
 * employee linked to the login — so there is no permission to check and no id
 * to guess; an asset that is someone else's is simply not found. The Assets
 * module still has to be enabled for the organization.
 */
@Controller('organization/me/assets')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.ASSETS, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyAssetsController {
  constructor(@Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy) {}

  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  // Static routes are declared before the `:assetId` one so they are never read as an id.

  @Get('requests')
  @ApiOperation({ summary: 'My repair, replacement and damage requests, newest first' })
  getMyRequests(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_MY_REQUESTS, this.actor(tenantId, userId, email));
  }

  @Post('requests')
  @ApiOperation({ summary: 'Ask for a repair or a replacement, or report damage, on one of my assets' })
  createMyRequest(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Body() dto: CreateAssetRequestDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.CREATE_MY_REQUEST, { ...this.actor(tenantId, userId, email), dto });
  }

  @Get()
  @ApiOperation({ summary: 'My Assets — what I have, with what still needs my signature first' })
  getMyAssets(@Headers('x-tenant-id') tenantId: string, @CurrentUser('id') userId: string, @CurrentUser('email') email: string) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.GET_MY_ASSETS, this.actor(tenantId, userId, email));
  }

  @Post(':assetId/accept')
  @ApiParam({ name: 'assetId' })
  @ApiOperation({ summary: 'Sign for an asset: I received it and it works. The signature is my full name' })
  acceptMyAsset(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() dto: AcceptAssetHandoverDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.ASSET.ACCEPT_MY_ASSET, { ...this.actor(tenantId, userId, email), assetId, dto });
  }
}
