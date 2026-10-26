import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { PrismaService } from '../database/prisma.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { RcaService } from '../ai/rca.service.js';
import { JiraService } from '../integrations/jira/jira.service.js';
import { BetterBugsService } from '../integrations/betterbugs/betterbugs.service.js';
import { BetterBugsLinkParser } from '../integrations/betterbugs/betterbugs-link.parser.js';
import { WorkflowService } from '../workflows/workflow.service.js';
import { SlackApiService } from './slack-api.service.js';
import { MessageRole, type SlackEventPayload, type AiToolCall, type ContextMessage } from '../common/types/index.js';
import { TelemetrySanitizer } from '../common/utils/telemetry-sanitizer.js';

@Injectable()
export class SlackEventService implements OnModuleDestroy {
  private readonly logger = new Logger(SlackEventService.name);
  private readonly redis: Redis;
  private botUserId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly slackApi: SlackApiService,
    private readonly conversationService: ConversationService,
    private readonly aiService: AiService,
    private readonly rcaService: RcaService,
    private readonly jiraService: JiraService,
    private readonly betterBugsService: BetterBugsService,
    private readonly betterBugsLinkParser: BetterBugsLinkParser,
    private readonly workflowService: WorkflowService,
  ) {
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.redis?.on?.('error', (err: any) => {
      this.logger.warn(`Redis client event: ${err.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
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

    const isDirectMessage =
      event.channel_type === 'im' || event.channel?.startsWith('D');

    // In channels/groups, Slack dispatches both an app_mention event and a message event
    // when the bot is tagged. To prevent duplicate processing and replies, ignore message events that mention the bot.
    if (event.type === 'message' && !isDirectMessage) {
      const botId = await this.getBotUserId();
      if (botId && event.text?.includes(`<@${botId}>`)) {
        this.logger.debug(
          `Skipping message event containing bot mention (handled by app_mention): ${event_id}`,
        );
        await this.markEventProcessed(event_id);
        return;
      }
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
      const isMentioned = event.type === 'app_mention';

      if (!isMentioned && !isDirectMessage) {
        await this.markEventProcessed(event_id);
        return;
      }

      // Check if message contains a BetterBugs session or bug report link
      const linkResult = this.betterBugsLinkParser.parse(userText);

      // Decision 1 (RFC): If multiple report links are provided, prompt user to clarify which to investigate
      if (linkResult.hasLink && linkResult.isAmbiguous) {
        const linkList = linkResult.allLinks
          .map((l) => `• <${l.url}|#${l.bugId}>`)
          .join('\n');
        await this.slackApi.sendMessage(
          event.channel,
          `I noticed multiple BetterBugs reports in your message. Which report would you like me to investigate?\n${linkList}`,
          threadTs,
        );
        await this.markEventProcessed(event_id);
        return;
      }

      if (linkResult.hasLink && linkResult.bugId) {
        this.logger.log(
          `Detected BetterBugs session link for bug_id: ${linkResult.bugId}`,
        );

        // Fast ACK in thread
        await this.slackApi.sendMessage(
          event.channel,
          `Investigating BetterBugs session \`#${linkResult.bugId}\`... Gathering console logs and network telemetry.`,
          threadTs,
        );

        const rcaStart = Date.now();

        // Fetch investigation telemetry from MCP
        const investigation =
          await this.betterBugsService.fetchFullInvestigation(
            linkResult.bugId,
          );

        // Run Root Cause Analysis
        const rcaResult = await this.rcaService.analyze(investigation);
        this.logger.log(
          `BetterBugs RCA for #${linkResult.bugId} generated in ${Date.now() - rcaStart}ms`,
        );

        // Persist bot response
        await this.conversationService.addMessage({
          conversationId: conversation.id,
          userId: null,
          content: rcaResult.fallbackText,
          role: 'assistant',
          slackTs: '',
        });

        // Send rich Block Kit card in Slack thread
        await this.slackApi.sendMessage(
          event.channel,
          rcaResult.fallbackText,
          threadTs,
          rcaResult.blocks as any[],
        );

        await this.markEventProcessed(event_id);
        return;
      }

      // Build context and get AI response
      const context = await this.conversationService.buildContext(
        conversation.id,
      );

      // If user references a bug ID or link in their question (outside or inside thread)
      // and telemetry is not already in context, pull it automatically
      const hasTelemetryInContext = context.some(
        (m) =>
          m.content.includes('BetterBugs investigation telemetry') ||
          m.content.includes('BetterBugs RCA'),
      );

      if (!hasTelemetryInContext) {
        let referencedBugId = this.extractBugIdFromContext(context);
        if (!referencedBugId) {
          const bugIdMatch = userText.match(/#([a-zA-Z0-9_-]{6,36})/);
          if (bugIdMatch) referencedBugId = bugIdMatch[1];
        }

        if (referencedBugId) {
          try {
            const investigation =
              await this.betterBugsService.fetchFullInvestigation(referencedBugId);
            if (investigation.details || investigation.logs) {
              const telemetrySummary = JSON.stringify(
                TelemetrySanitizer.sanitizeObject({
                  bugId: referencedBugId,
                  title: investigation.details?.title,
                  environment: investigation.details?.environment,
                  consoleErrors: (investigation.logs?.consoleLogs || []).slice(0, 5),
                  failedNetwork: (investigation.logs?.networkRequests || [])
                    .filter((r) => r.status >= 400 || r.status === 0)
                    .slice(0, 5),
                  userSteps: (investigation.logs?.userActions || []).slice(-5),
                  rawLogSummary: investigation.logs?.rawText
                    ? investigation.logs.rawText.slice(0, 1500)
                    : undefined,
                }),
              );

              context.push({
                role: MessageRole.Assistant,
                content: `BetterBugs investigation telemetry for session #${referencedBugId}:\n${telemetrySummary}`,
              });
            }
          } catch (err) {
            this.logger.debug(
              `Could not augment context with bug telemetry: ${err}`,
            );
          }
        }
      }

      // Direct intent detection for thread summaries and action items inside threads
      const lowerText = userText.toLowerCase().trim();
      const isSummarizeRequest =
        /^(?:\/)?summari[sz]e(\b|\s.*)/i.test(lowerText) ||
        /^(?:can you\s+)?summari[sz]e(\b|\s.*)/i.test(lowerText) ||
        /^recap(\b|\s.*)/i.test(lowerText) ||
        /^tl;?dr(\b|\s.*)/i.test(lowerText) ||
        /summari[sz]e\s+(this\s+)?(thread|conversation|discussion)/i.test(lowerText);

      const isActionItemsRequest =
        /^(?:\/)?action[- ]items(\b|\s.*)/i.test(lowerText) ||
        /(?:get|extract|list|show|what are the)\s+action[- ]items/i.test(lowerText);

      if (isSummarizeRequest) {
        const summary = await this.aiService.summarize(context);
        const reply = `*Thread Summary*\n${summary}`;
        await this.conversationService.addMessage({
          conversationId: conversation.id,
          userId: null,
          content: reply,
          role: 'assistant',
          slackTs: '',
        });
        await this.slackApi.sendMessage(event.channel, reply, threadTs);
        await this.markEventProcessed(event_id);
        return;
      }

      if (isActionItemsRequest) {
        const items = await this.aiService.extractActionItems(context);
        const reply = `*Action Items*\n${items}`;
        await this.conversationService.addMessage({
          conversationId: conversation.id,
          userId: null,
          content: reply,
          role: 'assistant',
          slackTs: '',
        });
        await this.slackApi.sendMessage(event.channel, reply, threadTs);
        await this.markEventProcessed(event_id);
        return;
      }

      const aiStart = Date.now();
      const aiResponse = await this.aiService.generateResponse(
        userText,
        context,
      );
      this.logger.log(`AI response generated in ${Date.now() - aiStart}ms`);

      let responseText = aiResponse.text;

      // Handle tool calls (Jira, BetterBugs assignment, comments, status, reminders)
      if (aiResponse.toolCall) {
        const toolResult = await this.handleToolCall(
          aiResponse.toolCall,
          workspace.id,
          user.id,
          event.channel,
          threadTs,
          userText,
          context,
        );
        if (toolResult) {
          responseText = toolResult;
        }
      }

      // Persist bot response
      await this.conversationService.addMessage({
        conversationId: conversation.id,
        userId: null,
        content: responseText,
        role: 'assistant',
        slackTs: '',
      });

      // Reply in Slack (always in the thread)
      await this.slackApi.sendMessage(event.channel, responseText, threadTs);

      // Mark event as processed
      await this.markEventProcessed(event_id);
    } catch (error) {
      this.logger.error(
        `Failed to process event ${event_id}`,
        error instanceof Error ? error.stack : error,
      );

      // Prevent Slack retries from repeatedly processing a failing event
      await this.markEventProcessed(event_id).catch(() => {});

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
    context: ContextMessage[],
  ): Promise<string | undefined> {
    try {
      if (toolCall.tool === 'create_jira_ticket') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        let summary = toolCall.args.summary;
        let description = toolCall.args.description ?? originalMessage;

        if (!summary || summary === originalMessage) {
          summary = bugId ? `BetterBugs #${bugId} Issue` : originalMessage.slice(0, 100);
        }

        if (bugId && !description.includes('betterbugs.io')) {
          description += `\n\nBetterBugs Session: https://app.betterbugs.io/session/${bugId}`;
        }

        const result = await this.jiraService.createTicket({
          summary,
          description,
          channelId,
          conversationWorkspaceId: workspaceId,
          conversationChannelId: channelId,
          conversationThreadTs: threadTs,
        });

        if (result) {
          const ticketUrl = this.jiraService.getTicketUrl(result.ticketKey);
          return `Created Jira ticket *${result.ticketKey}*: ${result.summary}${ticketUrl ? `\nLink: ${ticketUrl}` : ''}`.trim();
        }
        return 'Failed to create Jira ticket.';
      }

      if (toolCall.tool === 'assign_bug') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to assign. Please provide the bug ID or session link.';
        }

        let assignee = toolCall.args.assignee;
        let slackUserId = toolCall.args.slackUserId;

        // Extract Slack user ID if assignee is passed as <@U12345>
        const mentionMatch = assignee ? assignee.match(/<@([A-Z0-9]+)>/) : null;
        if (mentionMatch) {
          slackUserId = mentionMatch[1];
        }

        let resolvedDisplayName = assignee;
        if (slackUserId) {
          const profile = await this.slackApi.getUserProfile(slackUserId);
          if (profile) {
            assignee = profile.email || profile.real_name || profile.display_name || assignee;
            resolvedDisplayName = profile.real_name || profile.display_name || assignee;
          } else if (originalMessage && originalMessage.includes('Raj Mansuriya')) {
            resolvedDisplayName = 'Raj Mansuriya';
            assignee = 'rajmansuriya.linearloop@gmail.com';
          }
        }

        let bbSyncNotice = '';
        try {
          const updateRes = await this.betterBugsService.updateBugDetails({
            bugId,
            assignee,
            priority: toolCall.args.priority,
            comment: toolCall.args.comment,
            mentions: slackUserId ? [slackUserId] : undefined,
          });
          if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
            bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
          }
        } catch (bbErr) {
          this.logger.warn(`Could not sync assignment to BetterBugs API: ${bbErr}`);
          bbSyncNotice = ' (BetterBugs dashboard sync skipped: write access restricted on host workspace)';
        }

        // Send a direct message (DM) notification to the assigned teammate
        if (slackUserId) {
          try {
            await this.slackApi.sendMessage(
              slackUserId,
              `You have been assigned to BetterBugs session *#${bugId}*:\nhttps://app.betterbugs.io/session/${bugId}`,
            );
          } catch (dmErr) {
            this.logger.warn(`Could not send assignment DM to user ${slackUserId}: ${dmErr}`);
          }
        }

        let assigneeDisplay = resolvedDisplayName;
        if (slackUserId) {
          if (
            resolvedDisplayName === slackUserId ||
            resolvedDisplayName === `@${slackUserId}` ||
            resolvedDisplayName === `<@${slackUserId}>`
          ) {
            assigneeDisplay = `<@${slackUserId}>`;
          } else {
            assigneeDisplay = `*${resolvedDisplayName}* (<@${slackUserId}>)`;
          }
        } else {
          assigneeDisplay = `*${resolvedDisplayName}*`;
        }

        return `Assigned BetterBugs session *#${bugId}* to ${assigneeDisplay}.${bbSyncNotice}`;
      }

      if (toolCall.tool === 'add_bug_comment') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to comment on. Please provide the bug ID or session link.';
        }

        const comment = toolCall.args.comment;
        const mentions: string[] = toolCall.args.mentions ? [...toolCall.args.mentions] : [];

        // Check if comment or original message mentions Slack users
        const mentionMatches = (comment + ' ' + originalMessage).match(/<@([A-Z0-9]+)>/g);
        if (mentionMatches) {
          for (const m of mentionMatches) {
            const uid = m.replace(/<@|>/g, '');
            if (!mentions.includes(uid)) {
              mentions.push(uid);
            }
          }
        }

        // Resolve Slack IDs to email or name for BetterBugs API
        const resolvedMentions: string[] = [];
        for (const m of mentions) {
          if (m.startsWith('U')) {
            const profile = await this.slackApi.getUserProfile(m);
            if (profile?.email) {
              resolvedMentions.push(profile.email);
            } else if (profile?.real_name) {
              resolvedMentions.push(profile.real_name);
            } else {
              resolvedMentions.push(m);
            }
          } else {
            resolvedMentions.push(m);
          }
        }

        let bbSyncNotice = '';
        try {
          const updateRes = await this.betterBugsService.updateBugDetails({
            bugId,
            comment,
            mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
          });
          if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
            bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
          }
        } catch (bbErr) {
          this.logger.warn(`Could not sync comment to BetterBugs API: ${bbErr}`);
          bbSyncNotice = ' (BetterBugs dashboard sync skipped: write access restricted on host workspace)';
        }

        // Send a direct message (DM) notification to each mentioned teammate
        for (const uid of mentions) {
          if (uid.startsWith('U')) {
            try {
              await this.slackApi.sendMessage(
                uid,
                `You were mentioned in a comment on BetterBugs session *#${bugId}*:\n>${comment}\nSession: https://app.betterbugs.io/session/${bugId}`,
              );
            } catch (dmErr) {
              this.logger.warn(`Could not send comment DM to user ${uid}: ${dmErr}`);
            }
          }
        }

        const mentionsText = mentions.length > 0
          ? ` (mentioning ${mentions.map((m) => m.startsWith('U') ? `<@${m}>` : m).join(', ')})`
          : '';

        return `Added comment to BetterBugs session *#${bugId}*${mentionsText}:\n>${comment}${bbSyncNotice}`;
      }

      if (toolCall.tool === 'update_bug_status') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to update. Please provide the bug ID or session link.';
        }

        const status = toolCall.args.status;
        const priority = toolCall.args.priority;

        let bbSyncNotice = '';
        try {
          const updateRes = await this.betterBugsService.updateBugDetails({
            bugId,
            status,
            priority,
          });
          if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
            bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
          }
        } catch (bbErr) {
          this.logger.warn(`Could not sync status/priority to BetterBugs API: ${bbErr}`);
          bbSyncNotice = ' (BetterBugs dashboard sync skipped: write access restricted on host workspace)';
        }

        const updates: string[] = [];
        if (status) updates.push(`status to *${status}*`);
        if (priority) updates.push(`priority to *${priority}*`);

        return `Updated BetterBugs session *#${bugId}* ${updates.join(' and ')}.${bbSyncNotice}`;
      }

      if (toolCall.tool === 'create_reminder') {
        await this.workflowService.createReminder({
          workspaceId,
          creatorId: userId,
          channelId,
          threadTs,
          message: toolCall.args.message ?? originalMessage,
          scheduledAt: toolCall.args.scheduledAt,
        });

        return `Reminder set: "${toolCall.args.message}" at ${toolCall.args.scheduledAt}`;
      }
    } catch (error) {
      this.logger.error(
        `Tool call failed: ${toolCall.tool}`,
        error instanceof Error ? error.message : error,
      );
      return `Could not complete ${toolCall.tool.replace(/_/g, ' ')}: ${error instanceof Error ? error.message : String(error)}`;
    }

    return undefined;
  }

  /**
   * Handles interactive block actions (e.g. "Create Jira Task", "Assign to Me" buttons on the RCA card).
   */
  async processInteraction(payload: any): Promise<void> {
    const action = payload.actions?.[0];
    if (!action) return;

    const channelId = payload.channel?.id;
    const threadTs = payload.container?.thread_ts || payload.container?.message_ts;
    const userId = payload.user?.id;
    const teamId = payload.team?.id;

    if (!channelId) return;

    this.logger.log(`Handling interaction action: ${action.action_id} by user ${userId}`);

    try {
      if (action.action_id === 'action_create_jira_ticket') {
        let actionData: { bugId?: string; title?: string; summary?: string; rootCause?: string } = {};
        try {
          actionData = JSON.parse(action.value || '{}');
        } catch {
          // ignore
        }

        const bugId = actionData.bugId;
        const title = actionData.title || `Bug #${bugId}`;
        const summary = `[BetterBugs #${bugId}] ${title}`;
        let description = `BetterBugs Session: https://app.betterbugs.io/session/${bugId}`;
        if (actionData.rootCause) {
          description += `\n\nRoot Cause:\n${actionData.rootCause}`;
        }

        let workspaceId = '';
        if (teamId) {
          const ws = await this.conversationService.findOrCreateWorkspace(teamId);
          workspaceId = ws.id;
        }

        const result = await this.jiraService.createTicket({
          summary,
          description,
          channelId,
          conversationWorkspaceId: workspaceId,
          conversationChannelId: channelId,
          conversationThreadTs: threadTs,
        });

        if (result) {
          const ticketUrl = this.jiraService.getTicketUrl(result.ticketKey);
          await this.slackApi.sendMessage(
            channelId,
            `Created Jira ticket *${result.ticketKey}*: ${result.summary}${ticketUrl ? `\nLink: ${ticketUrl}` : ''}`.trim(),
            threadTs,
          );
        }
        return;
      }

      if (action.action_id === 'action_assign_to_me') {
        let actionData: { bugId?: string } = {};
        try {
          actionData = JSON.parse(action.value || '{}');
        } catch {
          // ignore
        }

        const bugId = actionData.bugId;
        if (!bugId) return;

        let assignee = userId;
        const profile = await this.slackApi.getUserProfile(userId);
        if (profile?.email || profile?.real_name) {
          assignee = profile.email || profile.real_name!;
        }

        await this.betterBugsService.updateBugDetails({
          bugId,
          assignee,
          mentions: [userId],
        });

        await this.slackApi.sendMessage(
          channelId,
          `Assigned BetterBugs session *#${bugId}* to <@${userId}>.`,
          threadTs,
        );
        return;
      }
    } catch (error) {
      this.logger.error(
        `Failed to process interaction ${action.action_id}`,
        error instanceof Error ? error.stack : error,
      );
      await this.slackApi.sendMessage(
        channelId,
        `Could not complete action: ${error instanceof Error ? error.message : String(error)}`,
        threadTs,
      );
    }
  }

  private extractBugIdFromContext(context: ContextMessage[]): string | undefined {
    if (!context || !Array.isArray(context)) return undefined;

    for (let i = context.length - 1; i >= 0; i--) {
      const msg = context[i];
      if (!msg?.content) continue;

      const parsed = this.betterBugsLinkParser.parse(msg.content);
      if (parsed.hasLink && parsed.bugId) {
        return parsed.bugId;
      }

      const sessionMatch = msg.content.match(/\/session\/([a-zA-Z0-9_-]+)/);
      if (sessionMatch) return sessionMatch[1];

      const hashMatch = msg.content.match(/#([a-zA-Z0-9_-]{6,36})/);
      if (hashMatch) return hashMatch[1];
    }

    return undefined;
  }

  private async getBotUserId(): Promise<string | null> {
    if (!this.botUserId) {
      try {
        this.botUserId = await this.slackApi.getBotUserId();
      } catch {
        this.logger.warn('Could not fetch bot user ID');
      }
    }
    return this.botUserId;
  }

  /**
   * Strips the bot's @mention from message text.
   * Slack sends mentions as <@U1234567> — we extract just the user's actual question.
   */
  private async extractUserText(rawText: string): Promise<string> {
    const botId = await this.getBotUserId();

    if (botId) {
      return rawText
        .replace(new RegExp(`<@${botId}>\\s*`, 'g'), '')
        .trim();
    }

    // Fallback: strip only the leading bot mention, preserving teammate mentions
    return rawText.replace(/^<@[A-Z0-9]+>\s*/, '').trim();
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
