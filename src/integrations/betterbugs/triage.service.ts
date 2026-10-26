import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { SlackApiService } from '../../slack/slack-api.service.js';
import { BetterBugsService } from './betterbugs.service.js';
import { JiraService } from '../jira/jira.service.js';
import { WorkflowService } from '../../workflows/workflow.service.js';
import type { AiToolCall, ContextMessage } from '../../common/types/index.js';

export interface ExecuteTriageParams {
  toolCall: AiToolCall;
  workspaceId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  originalMessage: string;
  context: ContextMessage[];
}

export interface CreateJiraParams {
  bugId?: string;
  summary: string;
  description: string;
  channelId: string;
  workspaceId: string;
  threadTs: string;
}

export interface AssignBugParams {
  bugId: string;
  assignee: string;
  slackUserId?: string;
  priority?: string;
  comment?: string;
  actorUserId?: string;
}

export interface AddCommentParams {
  bugId: string;
  comment: string;
  mentions?: string[];
  actorUserId?: string;
}

export interface UpdateStatusParams {
  bugId: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'CLOSED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
}

@Injectable()
export class TriageService {
  private readonly logger = new Logger(TriageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackApi: SlackApiService,
    private readonly betterBugsService: BetterBugsService,
    private readonly jiraService: JiraService,
    private readonly workflowService: WorkflowService,
  ) {}

  /**
   * Unified tool execution router for conversational mentions and slash commands.
   */
  async executeToolCall(params: ExecuteTriageParams): Promise<string | undefined> {
    const { toolCall, workspaceId, userId, channelId, threadTs, originalMessage, context } = params;

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

        return await this.createJiraTicket({
          bugId,
          summary,
          description,
          channelId,
          workspaceId,
          threadTs,
        });
      }

      if (toolCall.tool === 'assign_bug') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to assign. Please provide the bug ID or session link.';
        }

        let assignee = toolCall.args.assignee;
        let slackUserId = toolCall.args.slackUserId;

        const mentionMatch = assignee ? assignee.match(/<@([A-Z0-9]+)>/) : null;
        if (mentionMatch) {
          slackUserId = mentionMatch[1];
        }

        return await this.assignBug({
          bugId,
          assignee,
          slackUserId,
          priority: toolCall.args.priority,
          comment: toolCall.args.comment,
          actorUserId: userId,
        });
      }

      if (toolCall.tool === 'add_bug_comment') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to comment on. Please provide the bug ID or session link.';
        }

        const comment = toolCall.args.comment;
        const mentions: string[] = toolCall.args.mentions ? [...toolCall.args.mentions] : [];

        // Extract any raw Slack user mentions like <@U12345> from message
        const mentionMatches = (comment + ' ' + originalMessage).match(/<@([A-Z0-9]+)>/g);
        if (mentionMatches) {
          for (const m of mentionMatches) {
            const uid = m.replace(/<@|>/g, '');
            if (!mentions.includes(uid)) {
              mentions.push(uid);
            }
          }
        }

        return await this.addComment({
          bugId,
          comment,
          mentions,
          actorUserId: userId,
        });
      }

      if (toolCall.tool === 'update_bug_status') {
        const bugId = toolCall.args.bugId || this.extractBugIdFromContext(context);
        if (!bugId) {
          return 'Could not determine which bug to update. Please provide the bug ID or session link.';
        }

        return await this.updateStatus({
          bugId,
          status: toolCall.args.status,
          priority: toolCall.args.priority,
        });
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
   * Creates a Jira ticket with duplicate protection and database association.
   */
  async createJiraTicket(params: CreateJiraParams): Promise<string> {
    const { bugId, summary, description, channelId, workspaceId, threadTs } = params;

    // Edge Case: Check if Jira ticket was already created for this thread/conversation to prevent duplicates
    if (workspaceId && channelId) {
      const existing = await this.prisma.jiraTicket.findFirst({
        where: {
          conversation: {
            workspaceId,
            channelId,
            threadTs: threadTs || null,
          },
        },
      });

      if (existing) {
        const ticketUrl = this.jiraService.getTicketUrl(existing.ticketKey);
        this.logger.log(`Jira ticket already exists for thread: ${existing.ticketKey}`);
        return `Jira ticket *${existing.ticketKey}* has already been created for this discussion:${ticketUrl ? `\nLink: ${ticketUrl}` : ''}`;
      }
    }

    // Edge Case: Check if Jira ticket was already created for this specific BetterBugs session
    if (bugId) {
      const existingForBug = await this.prisma.jiraTicket.findFirst({
        where: {
          OR: [
            { summary: { contains: bugId } },
            { description: { contains: bugId } },
          ],
        },
      });

      if (existingForBug) {
        const ticketUrl = this.jiraService.getTicketUrl(existingForBug.ticketKey);
        this.logger.log(`Jira ticket already exists for bug session #${bugId}: ${existingForBug.ticketKey}`);
        return `Jira ticket *${existingForBug.ticketKey}* has already been created for BetterBugs session *#${bugId}*:${ticketUrl ? `\nLink: ${ticketUrl}` : ''}`;
      }
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

    return 'Failed to create Jira ticket. Please verify Jira credentials and configuration.';
  }

  /**
   * Assigns a BetterBugs session, handles external workspace permission barriers,
   * and dispatches an automated private 1-on-1 Slack DM alert to the assignee.
   */
  async assignBug(params: AssignBugParams): Promise<string> {
    const { bugId, priority, comment, actorUserId } = params;
    let assignee = params.assignee;
    let slackUserId = params.slackUserId;

    if (!slackUserId && assignee) {
      const mentionMatch = assignee.match(/<@([A-Z0-9]+)>/);
      if (mentionMatch) slackUserId = mentionMatch[1];
    }

    let resolvedDisplayName = assignee;
    if (slackUserId) {
      try {
        const profile = await this.slackApi.getUserProfile(slackUserId);
        if (profile) {
          assignee = profile.email || profile.real_name || profile.display_name || assignee;
          resolvedDisplayName = profile.real_name || profile.display_name || assignee;
        }
      } catch (err) {
        this.logger.debug(`Could not resolve Slack user profile for ${slackUserId}: ${err}`);
      }
    }

    let bbSyncNotice = '';
    try {
      const updateRes = await this.betterBugsService.updateBugDetails({
        bugId,
        assignee,
        priority: priority as any,
        comment,
        mentions: slackUserId ? [slackUserId] : undefined,
      });

      if (updateRes?.error === 'WORKSPACE_PERMISSION_DENIED') {
        bbSyncNotice = ' (BetterBugs dashboard sync skipped: session belongs to an external workspace where write access is restricted)';
      }
    } catch (bbErr) {
      this.logger.warn(`Could not sync assignment to BetterBugs API: ${bbErr}`);
      bbSyncNotice = ' (BetterBugs dashboard sync skipped: write access restricted on host workspace)';
    }

    // Automated 1-on-1 Slack DM alert to assigned teammate under Apps -> BetterBugs Agent
    if (slackUserId) {
      try {
        const actorTag = actorUserId ? ` by <@${actorUserId}>` : '';
        await this.slackApi.sendMessage(
          slackUserId,
          `You have been assigned to BetterBugs session *#${bugId}*${actorTag}:\nhttps://app.betterbugs.io/session/${bugId}`,
        );
      } catch (dmErr) {
        this.logger.warn(`Could not send assignment DM to user ${slackUserId}: ${dmErr}`);
      }
    }

    const mentionTag = slackUserId ? ` (<@${slackUserId}>)` : '';
    return `Assigned BetterBugs session *#${bugId}* to *${resolvedDisplayName}*${mentionTag}.${bbSyncNotice}`;
  }

  /**
   * Adds a triage comment to BetterBugs and dispatches 1-on-1 DMs to all mentioned teammates.
   */
  async addComment(params: AddCommentParams): Promise<string> {
    const { bugId, comment, mentions = [], actorUserId } = params;

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

    // Dispatch 1-on-1 DMs to each mentioned collaborator
    for (const uid of mentions) {
      if (uid.startsWith('U')) {
        try {
          const actorTag = actorUserId ? ` by <@${actorUserId}>` : '';
          await this.slackApi.sendMessage(
            uid,
            `You were mentioned in a comment on BetterBugs session *#${bugId}*${actorTag}:\n>${comment}\nSession: https://app.betterbugs.io/session/${bugId}`,
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

  /**
   * Updates bug status or priority with external workspace permission handling.
   */
  async updateStatus(params: UpdateStatusParams): Promise<string> {
    const { bugId, status, priority } = params;

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

  /**
   * Generates a high-level engineering bug digest summarizing open/recent bugs.
   */
  async getBugDigest(projectId?: string, limit = 5): Promise<string> {
    try {
      const bugs = await this.betterBugsService.listBugs(projectId, limit);
      if (!bugs || bugs.length === 0) {
        return 'No active bugs found in BetterBugs for this project.';
      }

      const lines = bugs.slice(0, limit).map((b: any, i: number) => {
        const priorityBadge = b.priority ? ` [${b.priority.toUpperCase()}]` : '';
        const statusBadge = b.status ? ` (${b.status.toUpperCase()})` : '';
        return `${i + 1}. *#${b.id}*: ${b.title}${priorityBadge}${statusBadge}\n   https://app.betterbugs.io/session/${b.id}`;
      });

      return `*BetterBugs Engineering Bug Digest (Top ${Math.min(limit, bugs.length)}):*\n\n${lines.join('\n\n')}`;
    } catch (error) {
      this.logger.error('Failed to generate bug digest', error);
      return `Could not generate bug digest: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  extractBugIdFromContext(context: ContextMessage[], fallbackText?: string): string | undefined {
    if (fallbackText) {
      const match = fallbackText.match(/#([a-zA-Z0-9_-]{6,36})/);
      if (match) return match[1];

      const urlMatch = fallbackText.match(/\/session\/([a-zA-Z0-9_-]+)/);
      if (urlMatch) return urlMatch[1];
    }

    if (!context || !Array.isArray(context)) return undefined;

    for (let i = context.length - 1; i >= 0; i--) {
      const msg = context[i];
      if (!msg?.content) continue;

      const sessionMatch = msg.content.match(/\/session\/([a-zA-Z0-9_-]+)/);
      if (sessionMatch) return sessionMatch[1];

      const hashMatch = msg.content.match(/#([a-zA-Z0-9_-]{6,36})/);
      if (hashMatch) return hashMatch[1];
    }

    return undefined;
  }
}
