import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service.js';
import { LlmProvider } from './llm.provider.js';
import { RcaService } from './rca.service.js';

@Module({
  imports: [ConfigModule],
  providers: [AiService, LlmProvider, RcaService],
  exports: [AiService, RcaService],
})
export class AiModule {}
