import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    // rawBody is required to verify Slack HMAC signatures correctly
    rawBody: true,
  });

  // NestJS handles urlencoded bodies internally when rawBody is enabled

  // Catch-all exception filter prevents exposing internal errors to Slack
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Gracefully handle SIGTERM/SIGINT and close database, Redis, and MCP connections
  app.enableShutdownHooks();

  const server = app.getHttpServer();
  server.on('clientError', (err: any, socket: any) => {
    if (err?.code === 'ECONNRESET' || !socket.writable) {
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  process.on('unhandledRejection', (reason: any) => {
    if (reason?.code === 'ECONNRESET') {
      logger.warn(`Network connection reset: ${reason.message}`);
      return;
    }
    logger.error('Unhandled Promise Rejection', reason);
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Slack bot is running on port ${port}`);
}
await bootstrap();
