import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseRpcExceptionFilter, RpcException } from '@nestjs/microservices';
import { Observable } from 'rxjs';

/**
 * Converts an HttpException thrown inside any @MessagePattern handler into an
 * RpcException carrying {statusCode, message, error} — without this, Nest's
 * default RPC error serialization drops the status code crossing the TCP
 * boundary, so AllExceptionsFilter at the gateway can't tell a deliberate 401
 * (invalid credentials) or 400 (duplicate slug) from an unhandled fault, and
 * defaults everything to 500.
 */
@Catch(HttpException)
export class HttpToRpcExceptionFilter extends BaseRpcExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): Observable<any> {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : (response as any)?.message || exception.message;

    return super.catch(
      new RpcException({ statusCode: status, message, error: exception.name }),
      host,
    );
  }
}
