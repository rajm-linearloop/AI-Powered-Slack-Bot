import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module.js';
import { ConversationService } from './conversation.service.js';

@Module({
  imports: [ConfigModule, DatabaseModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationsModule {}
