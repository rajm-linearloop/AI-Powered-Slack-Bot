import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommandsController } from './commands.controller.js';
import { CommandsService } from './commands.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { AiModule } from '../ai/ai.module.js';
import { SlackModule } from '../slack/slack.module.js';

import { JiraModule } from '../integrations/jira/jira.module.js';
import { BetterBugsModule } from '../integrations/betterbugs/betterbugs.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => ConversationsModule),
    forwardRef(() => AiModule),
    forwardRef(() => SlackModule),
    forwardRef(() => JiraModule),
    forwardRef(() => BetterBugsModule),
    forwardRef(() => WorkflowsModule),
  ],
  controllers: [CommandsController],
  providers: [CommandsService],
})
export class CommandsModule {}
