import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter.js';
import { urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // rawBody is required to verify Slack HMAC signatures correctly
    rawBody: true,
  });

  // NestJS handles urlencoded bodies internally when rawBody is enabled

  // Catch-all exception filter prevents exposing internal errors to Slack
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Slack bot is running on port ${port}`);
}
await bootstrap();
