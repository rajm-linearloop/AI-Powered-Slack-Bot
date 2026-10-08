import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { DatabaseModule } from '../database/database.module.js';
import { SlackModule } from '../slack/slack.module.js';
import { WorkflowService } from './workflow.service.js';
import { WorkflowProcessor } from './workflow.processor.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    forwardRef(() => SlackModule),
    BullModule.registerQueue({
      name: 'workflows',
    }),
  ],
  providers: [WorkflowService, WorkflowProcessor],
  exports: [WorkflowService],
})
export class WorkflowsModule {}
