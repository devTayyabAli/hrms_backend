import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { firstValueFrom } from 'rxjs';
import {
  CompleteMyLearningDto,
  GetMyLearningHistoryQueryDto,
  GetMyLearningQueryDto,
  HRMSModuleKey,
  MESSAGE_PATTERNS,
  ModuleAction,
  SERVICES,
} from '@app/common';
import { CurrentUser, JwtAuthGuard, OrganizationModuleGuard, RequireModule, TenantGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';
import { sendFileResponse } from '../utils/file-response.helper';

/**
 * My Learning (employee portal): the courses the signed-in employee has been
 * given — reading through them, and marking them completed.
 *
 * Like the rest of `organization/me`, everything is the caller's own: the
 * employee linked to the login. There is no permission to check and no
 * employee id to name; a course that is someone else's is simply not found.
 * The Learning module still has to be enabled for the organization.
 */
@Controller('organization/me/learning')
@ApiBearerAuth()
@ApiTags(TAGS.ORG_EMPLOYEE_PORTAL)
@UseGuards(JwtAuthGuard, TenantGuard, OrganizationModuleGuard)
@RequireModule(HRMSModuleKey.LEARNING, ModuleAction.VIEW)
@ApiHeader({ name: 'x-tenant-id', description: 'Organization Tenant ID', required: true })
export class MyLearningController {
  constructor(
    @Inject(SERVICES.TENANT_SERVICE) private readonly tenantClient: ClientProxy,
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  private actor(tenantId: string, userId: string, email: string) {
    return { tenantId, userId, email };
  }

  // Static routes are declared before the `:assignmentId` ones so they are never read as an id.

  @Get('history')
  @ApiOperation({ summary: 'My completed courses, newest first' })
  getHistory(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyLearningHistoryQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.GET_HISTORY, { ...this.actor(tenantId, userId, email), query });
  }

  @Get()
  @ApiOperation({ summary: 'My Learning: my courses, what is overdue first, with a count per status' })
  getMine(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Query() query: GetMyLearningQueryDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.GET_MINE, { ...this.actor(tenantId, userId, email), query });
  }

  @Get(':assignmentId')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'One of my courses with its materials and which I have opened' })
  getOne(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.GET_MINE_ONE, { ...this.actor(tenantId, userId, email), assignmentId });
  }

  @Post(':assignmentId/start')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Start a course (In Progress) without opening a material yet' })
  start(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.START, { ...this.actor(tenantId, userId, email), assignmentId });
  }

  @Post(':assignmentId/materials/:materialId/open')
  @ApiParam({ name: 'assignmentId' })
  @ApiParam({ name: 'materialId' })
  @ApiOperation({ summary: 'Record that I opened a material (a link, or a file I read elsewhere). It starts the course' })
  openMaterial(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.OPEN_MATERIAL, { ...this.actor(tenantId, userId, email), assignmentId, materialId });
  }

  @Get(':assignmentId/materials/:materialId/download')
  @ApiParam({ name: 'assignmentId' })
  @ApiParam({ name: 'materialId' })
  @ApiOperation({ summary: 'Open or download a file material. It counts as opened' })
  async download(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Param('materialId', ParseUUIDPipe) materialId: string,
    @Res() res: Response,
  ) {
    const material: { fileId: string } = await firstValueFrom(
      this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.GET_MATERIAL_FILE, { ...this.actor(tenantId, userId, email), assignmentId, materialId }),
    );
    const file: any = await firstValueFrom(this.authClient.send(MESSAGE_PATTERNS.FILE.DOWNLOAD_FILE, { fileId: material.fileId, userTenantId: tenantId }));
    if (file && file.buffer) return sendFileResponse(res, file, true);
    return res.status(404).json({ message: 'File stream unavailable.' });
  }

  @Post(':assignmentId/complete')
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Mark the course as completed. A course that needs every required material opened says how many are left' })
  complete(
    @Headers('x-tenant-id') tenantId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('email') email: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: CompleteMyLearningDto,
  ) {
    return this.tenantClient.send(MESSAGE_PATTERNS.LEARNING_SELF.COMPLETE, { ...this.actor(tenantId, userId, email), assignmentId, dto });
  }
}
