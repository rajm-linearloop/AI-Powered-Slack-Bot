import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommandsController } from './commands.controller.js';
import { CommandsService } from './commands.service.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { AiModule } from '../ai/ai.module.js';
import { SlackModule } from '../slack/slack.module.js';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => ConversationsModule),
    forwardRef(() => AiModule),
    forwardRef(() => SlackModule),
  ],
  controllers: [CommandsController],
  providers: [CommandsService],
})
export class CommandsModule {}
