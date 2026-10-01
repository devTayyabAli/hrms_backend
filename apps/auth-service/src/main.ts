import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  createMicroserviceValidationPipe,
  MicroserviceLoggingInterceptor,
  HttpToRpcExceptionFilter,
} from '@app/common';
import { AuthServiceModule } from './auth-service.module';

async function bootstrap() {
  const port = parseInt(process.env.AUTH_SERVICE_PORT || '3001', 10);

  /**
   * Bind to loopback unless explicitly overridden.
   *
   * This TCP port exposes every @MessagePattern in this service as an
   * unauthenticated admin API — login, password reset, credential creation
   * and platform settings included. The gateway's JWT and guard stack runs in
   * a different process and does not protect these handlers, and
   * SignedPayloadGuard currently covers only a subset of user-service's
   * patterns, none of auth-service's. Listening on 0.0.0.0 published all of
   * that to anyone who could reach the port.
   *
   * The gateway resolves this service via AUTH_SERVICE_HOST, which already
   * defaults to 127.0.0.1, so loopback is the correct default for single-host
   * and compose deployments. For a multi-host deployment set
   * AUTH_SERVICE_BIND_HOST to a private interface — and only ever to 0.0.0.0
   * behind a network policy that keeps this port off the public internet.
   */
  const bindHost = process.env.AUTH_SERVICE_BIND_HOST || '127.0.0.1';

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.TCP,
      options: {
        host: bindHost,
        port,
      },
    },
  );

  app.useGlobalPipes(createMicroserviceValidationPipe());
  app.useGlobalInterceptors(new MicroserviceLoggingInterceptor());
  app.useGlobalFilters(new HttpToRpcExceptionFilter());

  await app.listen();
  console.log(`Auth Microservice is listening on ${bindHost}:${port}`);
}
bootstrap();
