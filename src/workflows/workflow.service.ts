import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service.js';
import { WorkflowStatus, WorkflowType } from '../common/types/index.js';

export interface CreateReminderParams {
  workspaceId: string;
  creatorId: string;
  channelId: string;
  threadTs: string;
  message: string;
  scheduledAt: string;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('workflows') private readonly workflowsQueue: Queue,
  ) {}

  async createReminder(params: CreateReminderParams) {
    this.logger.log(`Creating reminder for ${params.scheduledAt}`);

    // Parse scheduled date
    const scheduledDate = new Date(params.scheduledAt);
    if (isNaN(scheduledDate.getTime())) {
      throw new Error(`Invalid scheduled date: ${params.scheduledAt}`);
    }

    // Persist to DB
    const workflow = await this.prisma.workflow.create({
      data: {
        type: WorkflowType.Reminder,
        status: WorkflowStatus.Pending,
        workspaceId: params.workspaceId,
        creatorId: params.creatorId,
        channelId: params.channelId,
        threadTs: params.threadTs,
        message: params.message,
        scheduledAt: scheduledDate,
      },
    });

    // Calculate delay in milliseconds
    const delay = Math.max(0, scheduledDate.getTime() - Date.now());

    // Enqueue delayed job
    await this.workflowsQueue.add(
      'execute-workflow',
      { workflowId: workflow.id },
      { delay },
    );

    return workflow;
  }
}
