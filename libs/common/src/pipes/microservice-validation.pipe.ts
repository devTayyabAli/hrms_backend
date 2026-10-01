import { ValidationPipe, ValidationError } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

function flattenValidationErrors(errors: ValidationError[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    if (error.constraints) {
      messages.push(...Object.values(error.constraints));
    }
    if (error.children && error.children.length > 0) {
      messages.push(...flattenValidationErrors(error.children));
    }
  }
  return messages;
}

/**
 * ValidationPipe for TCP microservice message-pattern handlers.
 *
 * The default ValidationPipe throws BadRequestException, an HTTP-flavored
 * exception. Over a TCP transport that doesn't round-trip cleanly, so this
 * throws RpcException instead with an {statusCode, message, error} shape the
 * gateway's AllExceptionsFilter already knows how to unpack.
 *
 * Only validates @Payload() parameters typed as a class-validator DTO class —
 * a plain TS interface/type-literal has no runtime metadata and is silently
 * skipped, so handlers must use real DTO classes for this to take effect.
 */
export function createMicroserviceValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
    exceptionFactory: (errors: ValidationError[]) => {
      const messages = flattenValidationErrors(errors);
      return new RpcException({
        statusCode: 400,
        message: messages.length > 0 ? messages : 'Validation failed',
        error: 'Bad Request',
      });
    },
  });
}
