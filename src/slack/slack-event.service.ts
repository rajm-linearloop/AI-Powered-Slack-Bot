import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { PrismaService } from '../database/prisma.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { JiraService } from '../integrations/jira/jira.service.js';
import { WorkflowService } from '../workflows/workflow.service.js';
import { SlackApiService } from './slack-api.service.js';
import type { SlackEventPayload, AiToolCall } from '../common/types/index.js';

@Injectable()
export class SlackEventService {
  private readonly logger = new Logger(SlackEventService.name);
  private readonly redis: Redis;
  private botUserId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly slackApi: SlackApiService,
    private readonly conversationService: ConversationService,
    private readonly aiService: AiService,
    private readonly jiraService: JiraService,
    private readonly workflowService: WorkflowService,
  ) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 3,
    });
  }

  async processEvent(payload: SlackEventPayload): Promise<void> {
    const { event, event_id, team_id } = payload;

    // Idempotency: skip duplicate events (Redis fast-check + DB fallback)
    if (await this.isDuplicateEvent(event_id)) {
      this.logger.debug(`Duplicate event ${event_id}, skipping`);
      return;
    }

    // Ignore bot messages to prevent loops
    if (event.bot_id || event.subtype === 'bot_message') {
      return;
    }

    // Only handle message events and app_mention events
    if (event.type !== 'message' && event.type !== 'app_mention') {
      return;
    }

    const userText = await this.extractUserText(event.text ?? '');
    if (!userText.trim()) {
      return;
    }

    this.logger.log(
      `Processing ${event.type} from user ${event.user} in channel ${event.channel}`,
    );

    try {
      // Resolve workspace and user
      const workspace =
        await this.conversationService.findOrCreateWorkspace(team_id);
      const user = await this.conversationService.findOrCreateUser(
        event.user!,
        workspace.id,
      );

      // Resolve conversation (thread-scoped)
      // If the message is in a thread, use thread_ts. Otherwise use the message ts as thread root.
      const threadTs = event.thread_ts ?? event.ts;
      const conversation =
        await this.conversationService.findOrCreateConversation(
          workspace.id,
          event.channel,
          threadTs,
        );

      // Persist user message
      await this.conversationService.addMessage({
        conversationId: conversation.id,
        userId: user.id,
        content: userText,
        role: 'user',
        slackTs: event.ts,
      });

      // ONLY generate an AI response if the bot was explicitly mentioned or if it's a DM.
      // Otherwise, we just passively record the message in the database so it can be summarized later.
      const isMentioned = event.type === 'app_mention' || (this.botUserId && event.text?.includes(`<@${this.botUserId}>`));
      const isDirectMessage = event.channel_type === 'im';

      if (!isMentioned && !isDirectMessage) {
        await this.markEventProcessed(event_id);
        return;
      }

      // Build context and get AI response
      const context = await this.conversationService.buildContext(
        conversation.id,
      );
      const aiResponse = await this.aiService.generateResponse(
        userText,
        context,
      );

      // Handle tool calls (Jira ticket creation, reminders)
      if (aiResponse.toolCall) {
        await this.handleToolCall(
          aiResponse.toolCall,
          workspace.id,
          user.id,
          event.channel,
          threadTs,
          userText,
        );
      }

      // Persist bot response
      await this.conversationService.addMessage({
        conversationId: conversation.id,
        userId: null,
        content: aiResponse.text,
        role: 'assistant',
        slackTs: '',
      });

      // Reply in Slack (always in the thread)
      await this.slackApi.sendMessage(event.channel, aiResponse.text, threadTs);

      // Mark event as processed
      await this.markEventProcessed(event_id);
    } catch (error) {
      this.logger.error(
        `Failed to process event ${event_id}`,
        error instanceof Error ? error.stack : error,
      );

      // Send a user-friendly error to Slack
      try {
        await this.slackApi.sendMessage(
          event.channel,
          "Sorry, I couldn't process that request right now. Please try again.",
          event.thread_ts ?? event.ts,
        );
      } catch {
        // If we can't even send the error message, just log it
        this.logger.error('Failed to send error message to Slack');
      }
    }
  }

  private async handleToolCall(
    toolCall: AiToolCall,
    workspaceId: string,
    userId: string,
    channelId: string,
    threadTs: string,
    originalMessage: string,
  ): Promise<void> {
    try {
      if (toolCall.tool === 'create_jira_ticket') {
        const result = await this.jiraService.createTicket({
          summary: toolCall.args.summary ?? originalMessage.slice(0, 100),
          description: toolCall.args.description ?? originalMessage,
          channelId,
          conversationWorkspaceId: workspaceId,
          conversationChannelId: channelId,
          conversationThreadTs: threadTs,
        });

        if (result) {
          await this.slackApi.sendMessage(
            channelId,
            `✅ Created Jira ticket *${result.ticketKey}*: ${result.summary}`,
            threadTs,
          );
        }
      } else if (toolCall.tool === 'create_reminder') {
        await this.workflowService.createReminder({
          workspaceId,
          creatorId: userId,
          channelId,
          threadTs,
          message: toolCall.args.message ?? originalMessage,
          scheduledAt: toolCall.args.scheduledAt,
        });

        await this.slackApi.sendMessage(
          channelId,
          `⏰ Reminder set: "${toolCall.args.message}" at ${toolCall.args.scheduledAt}`,
          threadTs,
        );
      }
    } catch (error) {
      this.logger.error(
        `Tool call failed: ${toolCall.tool}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Strips the bot's @mention from message text.
   * Slack sends mentions as <@U1234567> — we extract just the user's actual question.
   */
  private async extractUserText(rawText: string): Promise<string> {
    if (!this.botUserId) {
      try {
        this.botUserId = await this.slackApi.getBotUserId();
      } catch {
        this.logger.warn('Could not fetch bot user ID');
      }
    }

    if (this.botUserId) {
      return rawText
        .replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '')
        .trim();
    }

    // Fallback: strip any @mention pattern
    return rawText.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  }

  private async isDuplicateEvent(eventId: string): Promise<boolean> {
    try {
      // Redis fast-check: SET NX with 1-hour TTL
      const result = await this.redis.set(
        `event:${eventId}`,
        '1',
        'EX',
        3600,
        'NX',
      );

      if (result === null) {
        return true; // Key already existed — duplicate
      }

      // Also check DB for durability (handles Redis restart)
      const existing = await this.prisma.processedEvent.findUnique({
        where: { eventId },
      });

      return !!existing;
    } catch {
      // If Redis fails, fall back to DB-only check
      const existing = await this.prisma.processedEvent.findUnique({
        where: { eventId },
      });
      return !!existing;
    }
  }

  private async markEventProcessed(eventId: string): Promise<void> {
    try {
      await this.prisma.processedEvent.create({
        data: { eventId },
      });
    } catch {
      // Unique constraint violation means it's already stored — safe to ignore
    }
  }
}
