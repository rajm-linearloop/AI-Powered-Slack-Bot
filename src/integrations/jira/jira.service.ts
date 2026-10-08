import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service.js';

export interface CreateJiraTicketParams {
  summary: string;
  description: string;
  channelId: string;
  conversationWorkspaceId: string;
  conversationChannelId: string;
  conversationThreadTs: string;
}

@Injectable()
export class JiraService {
  private readonly logger = new Logger(JiraService.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly projectKey: string;
  private readonly isConfigured: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.baseUrl = this.configService.get<string>('jira.baseUrl') || '';
    this.email = this.configService.get<string>('jira.email') || '';
    this.apiToken = this.configService.get<string>('jira.apiToken') || '';
    this.projectKey = this.configService.get<string>('jira.projectKey') || '';

    this.isConfigured = !!(
      this.baseUrl &&
      this.email &&
      this.apiToken &&
      this.projectKey
    );

    if (!this.isConfigured) {
      this.logger.warn(
        'Jira integration is not fully configured (missing env vars). Jira ticket creation will be simulated.',
      );
    }
  }

  async createTicket(params: CreateJiraTicketParams) {
    this.logger.log(`Creating Jira ticket: ${params.summary}`);

    let ticketKey = `SIM-${Math.floor(Math.random() * 1000)}`;

    if (this.isConfigured) {
      try {
        const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString(
          'base64',
        );

        const response = await fetch(`${this.baseUrl}/rest/api/3/issue`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              project: {
                key: this.projectKey,
              },
              summary: params.summary,
              description: {
                type: 'doc',
                version: 1,
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        text: params.description,
                        type: 'text',
                      },
                    ],
                  },
                ],
              },
              issuetype: {
                name: 'Task', // Assuming 'Task' issue type exists, fallback to standard issue types
              },
            },
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          this.logger.error(
            `Jira API error: ${response.status} - ${errorBody}`,
          );
          throw new Error(
            `Failed to create Jira ticket: ${response.statusText}`,
          );
        }

        const data = await response.json();
        ticketKey = data.key;
      } catch (error) {
        this.logger.error('Failed to create Jira ticket', error);
        throw error;
      }
    }

    // Resolve conversation to link the ticket
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        workspaceId_channelId_threadTs: {
          workspaceId: params.conversationWorkspaceId,
          channelId: params.conversationChannelId,
          threadTs: params.conversationThreadTs ?? null,
        },
      },
    });

    if (conversation) {
      await this.prisma.jiraTicket.create({
        data: {
          ticketKey,
          summary: params.summary,
          description: params.description,
          conversationId: conversation.id,
        },
      });
    }

    return { ticketKey, summary: params.summary };
  }
}
