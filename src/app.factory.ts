import { Global, Module, Type, ValidationPipe } from '@nestjs/common';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ROLES_KEY } from './authz/roles.decorator';
import { enrichDocument, type RolesPorOperacion } from './common/openapi-enrich';
import { ProblemFilter } from './common/problem.filter';
import { loadEnv } from './config/env';
import { POOL_FACTORY, type PoolFactory } from './db/db.service';
import { RequestContextStore } from './tenancy/request-context';

/**
 * Opciones solo para pruebas: `controllers` extra (endpoints de ensayo para guards) y `poolFactory` (conexiones del
 * patrón probe, que terminan en ROLLBACK).
 */
export async function createApp(opts: { controllers?: Type<unknown>[]; poolFactory?: PoolFactory } = {}): Promise<NestFastifyApplication> {
  let root: Type<unknown> = AppModule;
  if (opts.controllers?.length || opts.poolFactory) {
    const imports: Type<unknown>[] = [AppModule];
    if (opts.poolFactory) {
      class ProbePools {}
      Global()(ProbePools);
      Module({ providers: [{ provide: POOL_FACTORY, useValue: opts.poolFactory }], exports: [POOL_FACTORY] })(ProbePools);
      imports.push(ProbePools);
    }
    class TestRoot {}
    Module({ imports, controllers: opts.controllers ?? [] })(TestRoot);
    root = TestRoot;
  }
  const env = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    root,
    new FastifyAdapter({
      trustProxy: true,
      requestIdHeader: 'x-request-id',
      genReqId: () => randomUUID(),
      bodyLimit: env.BODY_LIMIT_BYTES,
    }),
    { bufferLogs: true },
  );
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Cabeceras de seguridad. La API solo devuelve JSON: CSP cerrada por defecto.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  // CORS con lista blanca: un origen que no esté en CORS_ORIGINS no recibe cabeceras de permiso.
  await app.register(fastifyCors, {
    origin: env.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-restaurant-id', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });

  const fastify = app.getHttpAdapter().getInstance();
  // Contexto propio por request (AsyncLocalStorage): done() corre dentro de run().
  fastify.addHook('onRequest', (req, _reply, done) => {
    RequestContextStore.run({ requestId: req.id }, done);
  });
  fastify.addHook('onRequest', (req, reply, done) => {
    void reply.header('x-request-id', req.id);
    done();
  });
  // Una línea de log por request, con el mismo id que ve el cliente en x-request-id.
  fastify.addHook('onResponse', (req, reply, done) => {
    logger.log(
      { requestId: req.id, method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'request completed',
    );
    done();
  });
  // Swagger UI necesita scripts y estilos propios: solo /docs lleva una CSP más abierta.
  fastify.addHook('onSend', (req, reply, _payload, done) => {
    if (req.url.startsWith('/docs')) {
      void reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      );
    }
    done();
  });
  app.useGlobalFilters(new ProblemFilter());
  // Solo entra lo declarado en el DTO: campos extra → 400.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true }));

  // Swagger: encendido salvo en producción (o si SWAGGER_ENABLED lo fuerza).
  const swaggerOn = env.SWAGGER_ENABLED ? env.SWAGGER_ENABLED === 'true' : env.NODE_ENV !== 'production';
  if (!swaggerOn) return app;
  const doc = enrichDocument(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Bocadoo API')
        .setDescription('Backend de Bocadoo: planes de almuerzo prepago por QR.')
        .setVersion('0.4.0')
        .addBearerAuth()
        .build(),
    ),
    rolesByOperation(app),
  );
  SwaggerModule.setup('docs', app, doc);
  return app;
}

/** `operationId` (Controlador_método, el que genera Swagger) → roles de `@Roles` en el método o en la clase. */
function rolesByOperation(app: NestFastifyApplication): RolesPorOperacion {
  const out: RolesPorOperacion = {};
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (Type<unknown> & { name: string }) | null;
      if (!cls) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = (cls.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const roles = (Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, cls)) as string[] | undefined;
        if (roles?.length) out[`${cls.name}_${name}`] = roles;
      }
    }
  }
  return out;
}
