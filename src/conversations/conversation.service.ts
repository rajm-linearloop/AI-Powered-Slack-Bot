import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PrismaService } from '../database/prisma.service.js';
import { ContextMessage, MessageRole } from '../common/types/index.js';

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly maxContextMessages: number;
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.maxContextMessages = this.configService.getOrThrow<number>(
      'ai.maxContextMessages',
    );
    this.redis = new Redis({
      host: this.configService.getOrThrow<string>('redis.host'),
      port: this.configService.getOrThrow<number>('redis.port'),
      maxRetriesPerRequest: 3,
    });
  }

  async findOrCreateWorkspace(teamId: string) {
    const cacheKey = `workspace:${teamId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Ignore Redis errors to fail-open
    }

    let workspace = await this.prisma.workspace.findUnique({
      where: { teamId },
    });
    if (!workspace) {
      workspace = await this.prisma.workspace.create({
        data: { teamId },
      });
    }

    try {
      // Cache workspace for 24 hours to reduce DB load on every Slack message
      await this.redis.set(cacheKey, JSON.stringify(workspace), 'EX', 86400);
    } catch {
      // Ignore Redis errors
    }

    return workspace;
  }

  async findOrCreateUser(slackUserId: string, workspaceId: string) {
    let user = await this.prisma.user.findUnique({
      where: { slackUserId_workspaceId: { slackUserId, workspaceId } },
    });
    if (!user) {
      user = await this.prisma.user.create({
        data: { slackUserId, workspaceId },
      });
    }
    return user;
  }

  async findOrCreateConversation(
    workspaceId: string,
    channelId: string,
    threadTs?: string,
  ) {
    // Treat threadTs as null if undefined to match Prisma schema
    const actualThreadTs = threadTs ?? null;
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        workspaceId,
        channelId,
        threadTs: actualThreadTs,
      },
    });

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          workspaceId,
          channelId,
          threadTs: actualThreadTs,
        },
      });
    }
    return conversation;
  }

  async getLatestConversation(channelId: string) {
    return this.prisma.conversation.findFirst({
      where: { channelId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async addMessage(params: {
    conversationId: string;
    userId: string | null;
    content: string;
    role: string;
    slackTs: string;
  }) {
    return this.prisma.message.create({
      data: {
        conversationId: params.conversationId,
        userId: params.userId,
        content: params.content,
        role: params.role,
        slackTs: params.slackTs,
      },
    });
  }

  async getThreadMessages(conversationId: string) {
    // Get the most recent N messages to respect context limits
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: this.maxContextMessages,
    });
  }

  async buildContext(conversationId: string): Promise<ContextMessage[]> {
    const messages = await this.getThreadMessages(conversationId);

    // Reverse them to be in chronological order for the LLM
    return messages.reverse().map((msg: any) => ({
      role: msg.role as MessageRole,
      content: msg.content,
    }));
  }
}
