import { NestFactory } from '@nestjs/core';
import { ApiGatewayModule } from './api-gateway.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';

import { AllExceptionsFilter } from './filters/rpc-exception.filter';
import {
  SHARED_TAGS,
  SWAGGER_PORTALS,
  SWAGGER_TAG_GROUPS,
  type SwaggerTag,
} from './swagger/swagger-tags';
import { SWAGGER_DESCRIPTION } from './swagger/swagger-description';

/**
 * Narrows the combined OpenAPI document to the screens one portal calls.
 *
 * Operations are kept by tag, and a path survives only if at least one of its
 * methods did — otherwise the page would list routes with no operations under
 * them. Components are left whole: an unreferenced schema costs a few bytes
 * and is invisible in the UI, whereas pruning them by hand risks dropping one
 * that a kept operation reaches through a nested `$ref`.
 */
function portalDocument(
  master: OpenAPIObject,
  portal: { title: string; description: string; tags: ReadonlyArray<SwaggerTag> },
): OpenAPIObject {
  const allowed = new Set<string>([...portal.tags, ...SHARED_TAGS]);

  const paths: OpenAPIObject['paths'] = {};
  for (const [route, pathItem] of Object.entries(master.paths ?? {})) {
    const kept: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      // A path item also carries non-operation keys such as `parameters`.
      // Only an operation has tags, which is what we filter on.
      const tags = (operation as { tags?: string[] })?.tags;
      if (!Array.isArray(tags)) continue;
      if (tags.some((tag) => allowed.has(tag))) kept[method] = operation;
    }
    if (Object.keys(kept).length) paths[route] = kept as never;
  }

  return {
    ...master,
    info: {
      ...master.info,
      title: portal.title,
      description: portal.description,
    },
    paths,
    tags: (master.tags ?? []).filter((tag) => allowed.has(tag.name)),
  };
}

async function bootstrap() {
  const app = await NestFactory.create(ApiGatewayModule);

  // Behind a reverse proxy (Nginx, a load balancer, Docker's bridge) every
  // request's socket peer is the proxy, so rate limiting, the IP allowlist
  // and login audit would all see one address. TRUST_PROXY tells Express
  // which hops may set X-Forwarded-For: a hop count ("1"), "true", or a
  // subnet list ("loopback, uniquelocal"). Unset, nothing is trusted.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) {
    app
      .getHttpAdapter()
      .getInstance()
      .set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy);
  }

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SECURITY CONFIGURATION ERROR: ALLOWED_ORIGINS environment variable is required in production.',
      );
    }
    console.warn(
      'WARNING: ALLOWED_ORIGINS is not set — defaulting to http://localhost:3000/3001 for local development only.',
    );
    allowedOrigins.push('http://localhost:3000', 'http://localhost:3001');
  }

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id'],
  });

  // The refresh token travels as an httpOnly cookie (see
  // auth/refresh-token-cookie.ts), so the auth routes need it parsed. Without
  // this `req.cookies` is undefined, every refresh reports "no refresh token",
  // and a page reload signs the user out.
  app.use(cookieParser());

  /**
   * Baseline security response headers.
   *
   * Set inline rather than via Helmet so this fix adds no dependency — these
   * are the headers that actually matter for a JSON API and its docs page.
   * If Helmet is added later it supersedes this block; do not keep both.
   *
   * `x-powered-by` is removed because advertising the framework only helps
   * someone matching known CVEs against it.
   */
  app.use((_req: any, res: any, next: any) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // HSTS only in production: sending it from a local HTTP server would pin
    // the browser to https://localhost for the max-age and break dev.
    if (process.env.NODE_ENV === 'production') {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
    next();
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  /**
   * API documentation is a development tool and is not published in
   * production.
   *
   * `/api/docs` served the full surface of the platform to anyone who asked:
   * every route, every DTO field, the `x-tenant-id` header contract, and a
   * "Try it out" console pointed at the live API. That is a map of the attack
   * surface — and `persistAuthorization` means a token pasted into it is kept
   * in the browser's storage too.
   *
   * Set `ENABLE_API_DOCS=true` to serve them anyway (a private staging box, an
   * internal network). It is opt-in and never implied by anything else, so
   * production stays closed unless somebody deliberately opens it.
   */
  const isProduction = process.env.NODE_ENV === 'production';
  const docsEnabled = !isProduction || process.env.ENABLE_API_DOCS === 'true';

  if (docsEnabled) {
    const builder = new DocumentBuilder()
      .setTitle('HRMS Microservices API Gateway')
      .setDescription(SWAGGER_DESCRIPTION)
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey(
        { type: 'apiKey', name: 'x-tenant-id', in: 'header' },
        'x-tenant-id',
      );

    // Register every tag up front: SwaggerModule renders root-level tags in the
    // order they were added, so this is what groups /api/docs by portal and
    // screen instead of dumping one flat, alphabetical list.
    for (const { name, description } of SWAGGER_TAG_GROUPS) {
      builder.addTag(name, description);
    }

    // autoTagControllers must stay off: tags live on each route handler, so
    // letting Nest fall back to the controller class name would file every
    // operation under a second, screen-less tag as well.
    // Built inside the branch as well as served: `createDocument` walks every
    // controller in the app, which is pointless work when nothing serves it.
    const document = SwaggerModule.createDocument(app, builder.build(), {
      autoTagControllers: false,
    });
    // Neither sorter is set on purpose. No tagsSorter keeps the portal/screen
    // order declared in SWAGGER_TAG_GROUPS; no operationsSorter keeps each
    // screen in source order, so a screen that folds in several tabs still
    // reads tab by tab instead of being regrouped by HTTP method.
    const uiOptions = {
      swaggerOptions: {
        docExpansion: 'none',
        filter: true,
        persistAuthorization: true,
        displayRequestDuration: true,
      },
    };

    SwaggerModule.setup('api/docs', app, document, uiOptions);

    // One page per portal, filtered out of the document above rather than
    // rebuilt: a second createDocument walk would re-scan every controller,
    // and two independent walks could drift. A frontend team gets a page
    // holding only the screens their app calls.
    for (const portal of SWAGGER_PORTALS) {
      SwaggerModule.setup(
        `api/docs/${portal.slug}`,
        app,
        portalDocument(document, portal),
        uiOptions,
      );
    }

    if (isProduction) {
      console.warn(
        'WARNING: API documentation is being served in production because ENABLE_API_DOCS=true. ' +
          'It exposes every route and a live request console — leave it unset unless this host is private.',
      );
    }
  }


  const port = process.env.PORT || 3000;
  await app.listen(port);
  const server = app.getHttpServer();
  server.headersTimeout = 240000;
  server.requestTimeout = 240000;
  server.keepAliveTimeout = 65000;
  console.log(`API Gateway is running on: http://localhost:${port}/api/v1`);
  if (docsEnabled) {
    console.log(`Swagger Docs available at: http://localhost:${port}/api/docs`);
    for (const portal of SWAGGER_PORTALS) {
      console.log(`  ${portal.title}: http://localhost:${port}/api/docs/${portal.slug}`);
    }
  } else {
    console.log('Swagger Docs disabled (set ENABLE_API_DOCS=true to expose them)');
  }
}
bootstrap();
