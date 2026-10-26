import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import configuration from './config/configuration.js';
import { envValidationSchema } from './config/env.validation.js';

import { DatabaseModule } from './database/database.module.js';
import { SlackModule } from './slack/slack.module.js';
import { AiModule } from './ai/ai.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { CommandsModule } from './commands/commands.module.js';
import { JiraModule } from './integrations/jira/jira.module.js';
import { BetterBugsModule } from './integrations/betterbugs/betterbugs.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    // 1. Global Config Module
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),

    // 2. Global BullMQ config (Redis connection for queues)
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.getOrThrow<string>('redis.host'),
          port: configService.getOrThrow<number>('redis.port'),
          maxRetriesPerRequest: null,
          retryStrategy: (times: number) =>
            times > 3 ? null : Math.min(times * 200, 1000),
        },
      }),
    }),

    // 3. Application Modules
    DatabaseModule,
    SlackModule,
    AiModule,
    ConversationsModule,
    CommandsModule,
    JiraModule,
    BetterBugsModule,
    WorkflowsModule,
    HealthModule,
  ],
})
export class AppModule {}
