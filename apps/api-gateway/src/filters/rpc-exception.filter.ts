import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

function reasonPhrase(statusCode: number): string {
  return REASON_PHRASES[statusCode] || (statusCode >= 500 ? 'Internal Server Error' : 'Error');
}

/**
 * Central exception -> HTTP response mapping for the gateway.
 *
 * Exceptions thrown deliberately by this app or a downstream microservice
 * (HttpException, or an RPC error shaped like {statusCode, message, error} —
 * that's how RpcException payloads arrive here once they've crossed the TCP
 * boundary) carry a curated, client-safe message by construction: the
 * developer wrote it specifically to be shown to the caller (validation
 * errors, "invalid credentials", "role already exists", etc). Those are
 * always returned as-is, in every environment — suppressing them would break
 * normal error UX across the whole app, since virtually every business-rule
 * error surfaces this way.
 *
 * Anything that DOESN'T carry a recognizable 4xx status (a raw DB error, an
 * unhandled bug, a timeout, a dropped TCP connection, ...) is treated as an
 * unexpected server fault: full details always go to the server log, but the
 * client only gets the raw message outside production — in production it
 * gets a generic message, since these can otherwise leak internals (DB
 * schema/constraint names, file paths, stack frames, connection info).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    this.logFullDetails(exception);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload = typeof body === 'string' ? { statusCode: status, message: body, error: reasonPhrase(status) } : body;
      return response.status(status).json({ timestamp: new Date().toISOString(), ...payload });
    }

    const statusCode = this.resolveStatusCode(exception);
    const isCuratedClientError = statusCode < 500;

    if (isCuratedClientError) {
      return response.status(statusCode).json({
        statusCode,
        message: this.resolveMessage(exception),
        error: reasonPhrase(statusCode),
        timestamp: new Date().toISOString(),
      });
    }

    // Unexpected/server-side fault: never leak raw internals in production.
    if (process.env.NODE_ENV === 'production') {
      return response.status(statusCode).json({
        statusCode,
        message: 'An unexpected error occurred. Please try again later.',
        error: reasonPhrase(statusCode),
        timestamp: new Date().toISOString(),
      });
    }

    return response.status(statusCode).json({
      statusCode,
      message: this.resolveMessage(exception) || 'Unknown error',
      error: reasonPhrase(statusCode),
      timestamp: new Date().toISOString(),
    });
  }

  private resolveStatusCode(exception: any): number {
    if (typeof exception?.statusCode === 'number') return exception.statusCode;
    if (typeof exception?.status === 'number') return exception.status;
    if (typeof exception?.response?.statusCode === 'number') return exception.response.statusCode;
    if (typeof exception?.response?.status === 'number') return exception.response.status;
    if (exception?.status === 401 || exception?.statusCode === 401) return HttpStatus.UNAUTHORIZED;
    if (exception?.errorCode || exception?.code) {
      if (
        typeof exception?.message === 'string' &&
        (exception.message.includes('already exists') || exception.message.includes('duplicate'))
      ) {
        return HttpStatus.CONFLICT;
      }
      return HttpStatus.BAD_REQUEST;
    }
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private resolveMessage(exception: any): string | string[] {
    if (typeof exception?.message === 'string' && exception.message.length > 0) {
      return exception.message;
    }
    if (Array.isArray(exception?.message)) {
      return exception.message;
    }
    if (typeof exception?.response?.message === 'string') {
      return exception.response.message;
    }
    if (Array.isArray(exception?.response?.message)) {
      return exception.response.message;
    }
    if (typeof exception?.response === 'string') {
      return exception.response;
    }
    if (typeof exception?.error === 'string') {
      return exception.error;
    }
    return 'An unexpected microservice error occurred';
  }

  /**
   * Logs full exception details server-side only — this never reaches the
   * client. Captures `.stack` explicitly since plain Error instances don't
   * serialize it via a bare JSON.stringify (message/stack aren't own
   * enumerable properties on a base Error).
   */
  private logFullDetails(exception: any): void {
    if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      return;
    }
    try {
      this.logger.error('Exception captured', JSON.stringify(exception, null, 2));
    } catch {
      this.logger.error('Exception captured (unserializable)', String(exception));
    }
  }
}
