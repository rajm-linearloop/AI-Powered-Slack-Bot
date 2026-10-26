import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service.js';
import { SlackApiService } from '../slack/slack-api.service.js';
import { WorkflowStatus } from '../common/types/index.js';

@Processor('workflows')
export class WorkflowProcessor extends WorkerHost {
  private readonly logger = new Logger(WorkflowProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackApi: SlackApiService,
  ) {
    super();
  }

  async process(job: Job<{ workflowId: string }>): Promise<void> {
    const { workflowId } = job.data;
    this.logger.log(`Processing workflow ${workflowId}`);

    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      include: { creator: true },
    });

    if (!workflow) {
      this.logger.error(`Workflow ${workflowId} not found`);
      return;
    }

    if (workflow.status !== WorkflowStatus.Pending) {
      this.logger.warn(
        `Workflow ${workflowId} is not pending (status: ${workflow.status})`,
      );
      return;
    }

    try {
      // Send reminder to Slack
      const message = `*Reminder:* <@${workflow.creator.slackUserId}> asked me to remind you:\n\n${workflow.message}`;
      await this.slackApi.sendMessage(
        workflow.channelId,
        message,
        workflow.threadTs || undefined,
      );

      // Update DB
      await this.prisma.workflow.update({
        where: { id: workflowId },
        data: {
          status: WorkflowStatus.Completed,
          executedAt: new Date(),
        },
      });

      this.logger.log(`Workflow ${workflowId} completed successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to execute workflow ${workflowId}`,
        error instanceof Error ? error.stack : error,
      );

      // Update DB to reflect failure
      await this.prisma.workflow.update({
        where: { id: workflowId },
        data: {
          status: WorkflowStatus.Failed,
        },
      });

      throw error;
    }
  }
}
