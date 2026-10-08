import { Injectable, Logger } from '@nestjs/common';
import { SlackCommandPayload } from '../common/types/index.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { SlackApiService } from '../slack/slack-api.service.js';

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly aiService: AiService,
    private readonly slackApi: SlackApiService,
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

      let conversation;
      if (threadTs) {
        conversation = await this.conversationService.findOrCreateConversation(
          workspace.id,
          channel_id,
          threadTs,
        );
      }

      switch (command) {
        case '/help':
          await this.handleHelpCommand(channel_id, user_id, threadTs);
          break;
        case '/ask':
          await this.handleAskCommand(
            text,
            channel_id,
            user_id,
            threadTs,
            conversation?.id,
          );
          break;
        case '/summarize':
          await this.handleSummarizeCommand(
            channel_id,
            user_id,
            threadTs,
            conversation?.id,
          );
          break;
        case '/action-items':
          await this.handleActionItemsCommand(
            channel_id,
            user_id,
            threadTs,
            conversation?.id,
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
    const helpText = `*Available Commands:*
• \`/ask <question>\` - Ask a question to the AI assistant.
• \`/summarize\` - Summarize the current discussion (must be used in a thread).
• \`/action-items\` - Extract action items from the current discussion (must be used in a thread).
• \`/help\` - Show this help message.

*Other Features:*
• Direct message me or mention me (@Bot) to chat.
• Ask me to "Create a Jira ticket" or "Set a reminder" and I'll handle it automatically.`;

    await this.slackApi.sendEphemeral(channelId, userId, helpText, threadTs);
  }

  private async handleAskCommand(
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
        'Please provide a question after the /ask command. Example: `/ask What is OAuth?`',
        threadTs,
      );
      return;
    }

    // Build context if in a thread
    let context: any[] = [];
    if (conversationId) {
      context = await this.conversationService.buildContext(conversationId);
    }

    const aiResponse = await this.aiService.generateResponse(text, context);

    // For slash commands, we send the result back to the channel visibly or ephemerally.
    // If it's a general question, it's often better to send visibly so others see the answer.
    // However, if there's a threadTs, send in thread. If not, maybe just post in channel.
    await this.slackApi.sendMessage(
      channelId,
      `<@${userId}> asked: *${text}*\n\n${aiResponse.text}`,
      threadTs,
    );
  }

  private async handleSummarizeCommand(
    channelId: string,
    userId: string,
    threadTs?: string,
    conversationId?: string,
  ) {
    // If not in a thread, fallback to summarizing the latest active conversation in this channel
    let targetConversationId = conversationId;
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
    threadTs?: string,
    conversationId?: string,
  ) {
    // If not in a thread, fallback to extracting action items from the latest active conversation in this channel
    let targetConversationId = conversationId;
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
