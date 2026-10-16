import { ForbiddenException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { MESSAGE_PATTERNS } from '@app/common';

/**
 * The file store only checks that a file belongs to the tenant, so without
 * this anyone could attach — and so let a colleague download — a file another
 * person uploaded. Returns the file's real name, size and type so the message
 * cannot misdescribe it.
 */
export async function resolveOwnFile(authClient: ClientProxy, tenantId: string, userId: string, fileId: string) {
  const result: any = await firstValueFrom(
    authClient.send(MESSAGE_PATTERNS.FILE.GET_METADATA, { fileId, userTenantId: tenantId }),
  );
  const file = result?.data;
  if (!file || file.uploadedBy !== userId) {
    throw new ForbiddenException('You can only attach a file you uploaded yourself.');
  }
  return {
    fileId,
    fileName: file.originalName as string,
    mimeType: (file.mimeType ?? undefined) as string | undefined,
    sizeBytes: Number(file.size ?? 0),
  };
}
