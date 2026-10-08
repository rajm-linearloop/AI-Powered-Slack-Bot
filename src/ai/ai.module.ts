import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service.js';
import { LlmProvider } from './llm.provider.js';

@Module({
  imports: [ConfigModule],
  providers: [AiService, LlmProvider],
  exports: [AiService],
})
export class AiModule {}
