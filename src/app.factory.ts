import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem.filter';
import { RequestContextStore } from './tenancy/request-context';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, requestIdHeader: 'x-request-id', genReqId: () => randomUUID() }),
    { bufferLogs: true },
  );
  const logger = app.get(Logger);
  app.useLogger(logger);

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
  app.useGlobalFilters(new ProblemFilter());

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Bocadoo API')
      .setDescription('Backend de Bocadoo: planes de almuerzo prepago por QR.')
      .setVersion('0.2.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, doc);
  return app;
}
