import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebClient } from '@slack/web-api';
import { formatSlackMrkdwn } from '../common/utils/slack-formatter.js';

@Injectable()
export class SlackApiService {
  private readonly logger = new Logger(SlackApiService.name);
  private readonly client: WebClient;

  constructor(private readonly configService: ConfigService) {
    this.client = new WebClient(
      this.configService.getOrThrow<string>('slack.botToken'),
    );
  }

  async sendMessage(
    channel: string,
    text: string,
    threadTs?: string,
    blocks?: any[],
  ): Promise<void> {
    const formattedText = formatSlackMrkdwn(text).slice(0, 39000);
    try {
      await this.client.chat.postMessage({
        channel,
        text: formattedText,
        thread_ts: threadTs,
        ...(blocks && blocks.length > 0 ? { blocks } : {}),
      });
    } catch (error) {
      // If Slack rejects the message due to Block Kit formatting issues, fallback to plain formatted text
      if (blocks && blocks.length > 0) {
        this.logger.warn(
          `Failed to send message with blocks, attempting fallback to plain text: ${error instanceof Error ? error.message : error}`,
        );
        try {
          await this.client.chat.postMessage({
            channel,
            text: formattedText,
            thread_ts: threadTs,
          });
          return;
        } catch (fallbackErr) {
          this.logger.error(
            `Fallback text-only message also failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
          );
        }
      }

      this.logger.error(
        `Failed to send message to channel ${channel}`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  async sendEphemeral(
    channel: string,
    userId: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    try {
      const formattedText = formatSlackMrkdwn(text);
      await this.client.chat.postEphemeral({
        channel,
        user: userId,
        text: formattedText,
        thread_ts: threadTs,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send ephemeral message to user ${userId}`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  /** Retrieves the bot's own user ID so we can strip @mentions from messages */
  async getBotUserId(): Promise<string> {
    const result = await this.client.auth.test();
    return result.user_id as string;
  }

  /** Retrieves profile of a Slack user (name, display name, email) */
  async getUserProfile(
    userId: string,
  ): Promise<{ real_name?: string; display_name?: string; email?: string } | null> {
    try {
      const res = await this.client.users.profile.get({ user: userId });
      return res.profile
        ? {
            real_name: res.profile.real_name,
            display_name: res.profile.display_name,
            email: res.profile.email,
          }
        : null;
    } catch (error) {
      this.logger.warn(`Could not get profile for user ${userId}: ${error}`);
      return null;
    }
  }
}
