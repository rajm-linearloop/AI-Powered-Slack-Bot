import { Injectable, Logger } from '@nestjs/common';
import {
  SlackCommandPayload,
  ContextMessage,
  AiToolCall,
  MessageRole,
} from '../common/types/index.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { SlackApiService } from '../slack/slack-api.service.js';
import { JiraService } from '../integrations/jira/jira.service.js';
import { BetterBugsService } from '../integrations/betterbugs/betterbugs.service.js';
import { BetterBugsLinkParser } from '../integrations/betterbugs/betterbugs-link.parser.js';
import { WorkflowService } from '../workflows/workflow.service.js';
import { TelemetrySanitizer } from '../common/utils/telemetry-sanitizer.js';

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly aiService: AiService,
    private readonly slackApi: SlackApiService,
    private readonly jiraService: JiraService,
    private readonly betterBugsService: BetterBugsService,
    private readonly betterBugsLinkParser: BetterBugsLinkParser,
    private readonly workflowService: WorkflowService,
  ) {}

  async executeCommand(payload: SlackCommandPayload): Promise<void> {
    const { command, text, channel_id, user_id, team_id } = payload;

    // Command payloads from Slack don't reliably include thread_ts
    // unless the app has specific configuration for it, but we handle it if present.
    const threadTs = payload.thread_ts;

    this.logger.log(
      `Executing command ${command} from user ${user_id} in channel ${channel_id}`,
    );

    try {
      const workspace =
        await this.conversationService.findOrCreateWorkspace(team_id);
      await this.conversationService.findOrCreateUser(user_id, workspace.id);

      const conversation =
        await this.conversationService.findOrCreateConversation(
          workspace.id,
          channel_id,
          threadTs,
        );

      switch (command) {
        case '/help':
          await this.handleHelpCommand(channel_id, user_id, threadTs);
          break;
        case '/ask':
          await this.handleAskCommand(
            text,
            channel_id,
            user_id,
            workspace.id,
            threadTs,
            conversation.id,
          );
          break;
        case '/jira':
          await this.handleJiraCommand(
            text,
            channel_id,
            user_id,
            workspace.id,
            threadTs,
            conversation.id,
          );
          break;
        case '/assign':
          await this.handleAssignCommand(
            text,
            channel_id,
            user_id,
            threadTs,
            conversation.id,
          );
          break;
        case '/comment':
          await this.handleCommentCommand(
            text,
            channel_id,
            user_id,
            threadTs,
            conversation.id,
          );
          break;
        case '/summarize':
          await this.handleSummarizeCommand(
            channel_id,
            user_id,
            text,
            threadTs,
            conversation.id,
          );
          break;
        case '/action-items':
          await this.handleActionItemsCommand(
            channel_id,
            user_id,
            text,
            threadTs,
            conversation.id,
          );
          break;
        default:
          this.logger.warn(`Unknown command: ${command}`);
          await this.slackApi.sendEphemeral(
            channel_id,
            user_id,
            `Unknown command: ${command}`,
          );
      }
    } catch (error) {
      this.logger.error(
        `Command execution failed: ${command}`,
        error instanceof Error ? error.stack : error,
      );
      await this.slackApi.sendEphemeral(
        channel_id,
        user_id,
        "Sorry, I couldn't process that command right now. Please try again.",
      );
    }
  }

  private async handleHelpCommand(
    channelId: string,
    userId: string,
    threadTs?: string,
  ) {
    const helpText = `*BetterBugs Agent Commands:*
• \`/ask <question>\` - Ask a question to BetterBugs Agent.
• \`/jira <summary>\` - Create a Jira task for this bug/thread.
• \`/assign <@user>\` - Assign this bug report to a teammate.
• \`/comment <note>\` - Add a comment or note to the BetterBugs report.
• \`/summarize\` - Summarize the current discussion (must be used in a thread).
• \`/action-items\` - Extract action items from the current discussion (must be used in a thread).
• \`/help\` - Show this help message.

*Conversational Features (in thread or DM):*
• Tag @BetterBugs Agent with a session link to run Root Cause Analysis.
• Tag @BetterBugs Agent to triage:
  - "Assign this bug to @Alex"
  - "Add comment: Verified fix on staging"
  - "Create a Jira ticket for this"
  - "Update status to IN_PROGRESS and priority to HIGH"
  - "Set a reminder for tomorrow at 10am"`;

    await this.slackApi.sendEphemeral(channelId, userId, helpText, threadTs);
  }

  private async handleAskCommand(
    text: string,
    channelId: string,
    userId: string,
    workspaceId: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    if (!text.trim()) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Please provide a question after the /ask command. Example: `/ask What is OAuth?`',
        threadTs,
      );
      return;
    }

    // Build context if in a thread
    let context: ContextMessage[] = [];
    if (conversationId) {
      context = await this.conversationService.buildContext(conversationId);
    }

    // Check if user references a bug ID or link in their question (useful when /ask is run outside thread)
    const linkParse = this.betterBugsLinkParser.parse(text);
    let referencedBugId = linkParse.bugId;
    if (!referencedBugId) {
      const match = text.match(/#([a-zA-Z0-9_-]{6,36})/);
      if (match) referencedBugId = match[1];
    }

    if (referencedBugId) {
      try {
        const investigation = await this.betterBugsService.fetchFullInvestigation(referencedBugId);
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
        this.logger.debug(`Could not augment /ask context with telemetry: ${err}`);
      }
    }

    const aiResponse = await this.aiService.generateResponse(text, context);
    let responseText = aiResponse.text;

    if (aiResponse.toolCall) {
      const toolResult = await this.executeToolCall(
        aiResponse.toolCall,
        workspaceId,
        userId,
        channelId,
        threadTs || '',
        text,
        context,
      );
      if (toolResult) {
        responseText = toolResult;
      }
    }

    // Persist conversation history so multi-turn /ask and /summarize retain thread context
    if (conversationId) {
      try {
        const user = await this.conversationService.findOrCreateUser(userId, workspaceId);
        await this.conversationService.addMessage({
          conversationId,
          userId: user.id,
          content: text,
          role: 'user',
          slackTs: threadTs || '',
        });
        await this.conversationService.addMessage({
          conversationId,
          userId: null,
          content: responseText,
          role: 'assistant',
          slackTs: '',
        });
      } catch (err) {
        this.logger.debug(`Could not persist /ask interaction: ${err}`);
      }
    }

    await this.slackApi.sendMessage(
      channelId,
      `<@${userId}> asked: *${text}*\n\n${responseText}`,
      threadTs,
    );
  }

  private async handleJiraCommand(
    text: string,
    channelId: string,
    userId: string,
    workspaceId: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    let context: ContextMessage[] = [];
    if (conversationId) {
      context = await this.conversationService.buildContext(conversationId);
    }

    const bugId = this.extractBugIdFromContext(context, text);
    let summary = text.trim();
    if (!summary) {
      summary = bugId ? `BetterBugs #${bugId} Issue` : 'BetterBugs Investigation Task';
    }

    let description = `Created via /jira by <@${userId}>`;
    if (bugId) {
      description += `\n\nBetterBugs Session: https://app.betterbugs.io/session/${bugId}`;
    }

    const result = await this.jiraService.createTicket({
      summary,
      description,
      channelId,
      conversationWorkspaceId: workspaceId,
      conversationChannelId: channelId,
      conversationThreadTs: threadTs || '',
    });

    if (result) {
      const ticketUrl = this.jiraService.getTicketUrl(result.ticketKey);
      await this.slackApi.sendMessage(
        channelId,
        `Created Jira ticket *${result.ticketKey}*: ${result.summary}${ticketUrl ? `\nLink: ${ticketUrl}` : ''}`.trim(),
        threadTs,
      );
    } else {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Failed to create Jira ticket. Please check Jira configuration.',
        threadTs,
      );
    }
  }

  private async handleAssignCommand(
    text: string,
    channelId: string,
    userId: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    if (!text.trim()) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Please specify the teammate to assign to. Example: `/assign @Alex`',
        threadTs,
      );
      return;
    }

    let context: ContextMessage[] = [];
    if (conversationId) {
      context = await this.conversationService.buildContext(conversationId);
    }

    const bugId = this.extractBugIdFromContext(context, text);
    if (!bugId) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Could not determine which bug to assign. Please run this command inside a thread with a BetterBugs session or include the bug ID (e.g. `/assign #bug-123 @Alex`).',
        threadTs,
      );
      return;
    }

    let assignee = text.trim();
    let slackUserId: string | undefined;

    const mentionMatch = assignee.match(/<@([A-Z0-9]+)>/);
    if (mentionMatch) {
      slackUserId = mentionMatch[1];
    }

    let resolvedName = assignee;
    if (slackUserId) {
      const profile = await this.slackApi.getUserProfile(slackUserId);
      if (profile) {
        assignee = profile.email || profile.real_name || profile.display_name || assignee;
        resolvedName = profile.real_name || profile.display_name || assignee;
      }
    }

    let bbSyncNotice = '';
    try {
      const updateRes = await this.betterBugsService.updateBugDetails({
        bugId,
        assignee,
        mentions: slackUserId ? [slackUserId] : undefined,
      });
      if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
        bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
      }
    } catch (err) {
      this.logger.warn(`Could not sync assignment to BetterBugs API: ${err}`);
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

    const mentionTag = slackUserId ? ` (<@${slackUserId}>)` : '';
    await this.slackApi.sendMessage(
      channelId,
      `Assigned BetterBugs session *#${bugId}* to *${resolvedName}*${mentionTag}.${bbSyncNotice}`,
      threadTs,
    );
  }

  private async handleCommentCommand(
    text: string,
    channelId: string,
    userId: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    if (!text.trim()) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Please provide a comment. Example: `/comment Verified on staging`',
        threadTs,
      );
      return;
    }

    let context: ContextMessage[] = [];
    if (conversationId) {
      context = await this.conversationService.buildContext(conversationId);
    }

    const bugId = this.extractBugIdFromContext(context, text);
    if (!bugId) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'Could not determine which bug to comment on. Please run this command inside a thread with a BetterBugs session or include the bug ID.',
        threadTs,
      );
      return;
    }

    const mentions: string[] = [];
    const mentionMatches = text.match(/<@([A-Z0-9]+)>/g);
    if (mentionMatches) {
      for (const m of mentionMatches) {
        mentions.push(m.replace(/<@|>/g, ''));
      }
    }

    const resolvedMentions: string[] = [];
    for (const m of mentions) {
      const profile = await this.slackApi.getUserProfile(m);
      if (profile?.email) {
        resolvedMentions.push(profile.email);
      } else if (profile?.real_name) {
        resolvedMentions.push(profile.real_name);
      }
    }

    let bbSyncNotice = '';
    try {
      const updateRes = await this.betterBugsService.updateBugDetails({
        bugId,
        comment: text,
        mentions: resolvedMentions.length > 0 ? resolvedMentions : undefined,
      });
      if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
        bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
      }
    } catch (err) {
      this.logger.warn(`Could not sync comment to BetterBugs API: ${err}`);
      bbSyncNotice = ' (BetterBugs dashboard sync skipped: write access restricted on host workspace)';
    }

    // Send a direct message (DM) notification to each mentioned teammate
    for (const uid of mentions) {
      if (uid.startsWith('U')) {
        try {
          await this.slackApi.sendMessage(
            uid,
            `You were mentioned in a comment on BetterBugs session *#${bugId}*:\n>${text}\nSession: https://app.betterbugs.io/session/${bugId}`,
          );
        } catch (dmErr) {
          this.logger.warn(`Could not send comment DM to user ${uid}: ${dmErr}`);
        }
      }
    }

    const mentionsText = mentions.length > 0
      ? ` (mentioning ${mentions.map((m) => `<@${m}>`).join(', ')})`
      : '';

    await this.slackApi.sendMessage(
      channelId,
      `Added comment to BetterBugs session *#${bugId}*${mentionsText}:\n>${text}${bbSyncNotice}`,
      threadTs,
    );
  }

  private async executeToolCall(
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

        const mentionMatch = assignee.match(/<@([A-Z0-9]+)>/);
        if (mentionMatch) {
          slackUserId = mentionMatch[1];
        }

        let resolvedDisplayName = assignee;
        if (slackUserId) {
          const profile = await this.slackApi.getUserProfile(slackUserId);
          if (profile) {
            assignee = profile.email || profile.real_name || profile.display_name || assignee;
            resolvedDisplayName = profile.real_name || profile.display_name || assignee;
          }
        }

        let bbSyncNotice = '';
        try {
          const updateRes = await this.betterBugsService.updateBugDetails({
            bugId,
            assignee,
            comment: toolCall.args.comment,
            mentions: slackUserId ? [slackUserId] : undefined,
          });
          if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
            bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
          }
        } catch (err) {
          this.logger.warn(`Could not sync assignment to BetterBugs API: ${err}`);
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

        const mentionTag = slackUserId ? ` (<@${slackUserId}>)` : '';
        return `Assigned BetterBugs session *#${bugId}* to *${resolvedDisplayName}*${mentionTag}.${bbSyncNotice}`;
      }

      if (toolCall.tool === 'add_bug_comment') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to comment on. Please provide the bug ID or session link.';
        }

        const comment = toolCall.args.comment;
        const mentions: string[] = toolCall.args.mentions ? [...toolCall.args.mentions] : [];

        const mentionMatches = (comment + ' ' + originalMessage).match(/<@([A-Z0-9]+)>/g);
        if (mentionMatches) {
          for (const m of mentionMatches) {
            const uid = m.replace(/<@|>/g, '');
            if (!mentions.includes(uid)) {
              mentions.push(uid);
            }
          }
        }

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
        } catch (err) {
          this.logger.warn(`Could not sync comment to BetterBugs API: ${err}`);
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
        `Tool execution in command failed: ${toolCall.tool}`,
        error instanceof Error ? error.message : error,
      );
      return `Could not complete ${toolCall.tool.replace(/_/g, ' ')}: ${error instanceof Error ? error.message : String(error)}`;
    }

    return undefined;
  }

  private extractBugIdFromContext(context: ContextMessage[], fallbackText?: string): string | undefined {
    if (fallbackText) {
      const parsed = this.betterBugsLinkParser.parse(fallbackText);
      if (parsed.hasLink && parsed.bugId) return parsed.bugId;

      const hashMatch = fallbackText.match(/#([a-zA-Z0-9_-]{6,36})/);
      if (hashMatch) return hashMatch[1];
    }

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

  private async handleSummarizeCommand(
    channelId: string,
    userId: string,
    text?: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    let targetConversationId = conversationId;

    // Check if the user specified a bug ID or link in the command, e.g. /summarize #6ad0b82f6d0a6b8bf2b9325b
    if (text) {
      const linkParse = this.betterBugsLinkParser.parse(text);
      let bugId = linkParse.bugId;
      if (!bugId) {
        const match = text.match(/#?([a-zA-Z0-9_-]{6,36})/);
        if (match) bugId = match[1];
      }
      if (bugId) {
        const matchingConv = await this.conversationService.findConversationByBugId(channelId, bugId);
        if (matchingConv) {
          targetConversationId = matchingConv.id;
        }
      }
    }

    // If not in a thread and no specific bug conversation was matched, fallback to summarizing the latest active conversation in this channel
    if (!targetConversationId) {
      const latestConv =
        await this.conversationService.getLatestConversation(channelId);
      if (latestConv) {
        targetConversationId = latestConv.id;
      }
    }

    if (!targetConversationId) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'There are no recent conversations in this channel to summarize.',
      );
      return;
    }

    const context =
      await this.conversationService.buildContext(targetConversationId);
    if (context.length === 0) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'There are no messages to summarize.',
        threadTs,
      );
      return;
    }

    const summary = await this.aiService.summarize(context);

    await this.slackApi.sendMessage(
      channelId,
      `*Thread Summary*\n${summary}`,
      threadTs,
    );
  }

  private async handleActionItemsCommand(
    channelId: string,
    userId: string,
    text?: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    let targetConversationId = conversationId;

    // Check if the user specified a bug ID or link in the command, e.g. /action-items #6ad0b82f6d0a6b8bf2b9325b
    if (text) {
      const linkParse = this.betterBugsLinkParser.parse(text);
      let bugId = linkParse.bugId;
      if (!bugId) {
        const match = text.match(/#?([a-zA-Z0-9_-]{6,36})/);
        if (match) bugId = match[1];
      }
      if (bugId) {
        const matchingConv = await this.conversationService.findConversationByBugId(channelId, bugId);
        if (matchingConv) {
          targetConversationId = matchingConv.id;
        }
      }
    }

    // If not in a thread and no specific bug conversation was matched, fallback to extracting action items from the latest active conversation in this channel
    if (!targetConversationId) {
      const latestConv =
        await this.conversationService.getLatestConversation(channelId);
      if (latestConv) {
        targetConversationId = latestConv.id;
      }
    }

    if (!targetConversationId) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'There are no recent conversations in this channel to extract action items from.',
      );
      return;
    }

    const context =
      await this.conversationService.buildContext(targetConversationId);
    if (context.length === 0) {
      await this.slackApi.sendEphemeral(
        channelId,
        userId,
        'There are no messages to extract action items from.',
        threadTs,
      );
      return;
    }

    const actionItems = await this.aiService.extractActionItems(context);

    await this.slackApi.sendMessage(
      channelId,
      `*Action Items*\n${actionItems}`,
      threadTs,
    );
  }
}
