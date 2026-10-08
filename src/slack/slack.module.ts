import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SlackController } from './slack.controller.js';
import { SlackEventService } from './slack-event.service.js';
import { SlackApiService } from './slack-api.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { AiModule } from '../ai/ai.module.js';
import { JiraModule } from '../integrations/jira/jira.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    forwardRef(() => ConversationsModule),
    forwardRef(() => AiModule),
    forwardRef(() => JiraModule),
    forwardRef(() => WorkflowsModule),
  ],
  controllers: [SlackController],
  providers: [SlackEventService, SlackApiService],
  exports: [SlackApiService],
})
export class SlackModule {}
