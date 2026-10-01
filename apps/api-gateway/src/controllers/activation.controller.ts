import { Controller, Post, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { Throttle } from '@nestjs/throttler';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  ActivateAdminDto,
  ValidateInvitationTokenDto,
  Public,
} from '@app/common';

@Controller('organization-admin')
@Public()
export class OrganizationAdminActivationController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
  ) {}

  @ApiTags(TAGS.ORG_ACTIVATION)
  @Post('validate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Validate Organization Admin Invitation Token' })
  validateInvitationToken(@Body() dto: ValidateInvitationTokenDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.VALIDATE, dto);
  }

  @ApiTags(TAGS.ORG_ACTIVATION)
  @Post('activate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Activate Organization Admin Account & Set Password' })
  activateAdminAccount(@Body() dto: ActivateAdminDto) {
    return this.tenantClient.send(MESSAGE_PATTERNS.INVITATION.ACTIVATE, dto);
  }
}
