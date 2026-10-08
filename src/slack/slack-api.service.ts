import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebClient } from '@slack/web-api';

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
  ): Promise<void> {
    try {
      await this.client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
      });
    } catch (error) {
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
      await this.client.chat.postEphemeral({
        channel,
        user: userId,
        text,
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
}
