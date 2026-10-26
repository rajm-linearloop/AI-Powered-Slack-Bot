import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  ContextMessage,
  AiResponse,
  AiToolCall,
} from '../common/types/index.js';

@Injectable()
export class LlmProvider {
  private readonly logger = new Logger(LlmProvider.name);
  private readonly openai: OpenAI;
  private readonly modelName: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('ai.apiKey');
    this.modelName =
      this.configService.get<string>('ai.model') ||
      process.env.AI_MODEL ||
      'openai/gpt-4o-mini';
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey,
    });
    this.logger.log(`LlmProvider initialized with model: ${this.modelName}`);
  }

  /**
   * Generates a response using the OpenRouter API (OpenAI compatible), with optional tools.
   */
  async generateContent(
    systemPrompt: string,
    context: ContextMessage[],
    userMessage?: string,
    useTools = true,
  ): Promise<AiResponse> {
    // Map our generic context roles to OpenAI roles
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...context.map((msg) => ({
        role:
          msg.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: msg.content,
      })),
    ];

    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    const requestOptions: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model: this.modelName,
      messages,
      max_tokens: 1000,
    };

    if (useTools) {
      requestOptions.tools = this.getTools();
      requestOptions.tool_choice = 'auto';
    }

    try {
      const startTime = Date.now();
      const response =
        await this.openai.chat.completions.create(requestOptions);
      this.logger.debug(
        `OpenRouter response received in ${Date.now() - startTime}ms`,
      );
      return this.parseResponse(response);
    } catch (error) {
      this.logger.error(
        'OpenRouter API call failed',
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  private parseResponse(response: OpenAI.Chat.ChatCompletion): AiResponse {
    const message = response.choices[0]?.message;

    if (!message) {
      return { text: 'I am sorry, I did not understand that.' };
    }

    // Check if there is a function/tool call
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];

      let args = {};
      if (toolCall.type === 'function') {
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          this.logger.error('Failed to parse tool call arguments', e);
        }

        return {
          text:
            message.content ||
            `I am working on your request to ${toolCall.function.name.replace(/_/g, ' ')}...`,
          toolCall: {
            tool: toolCall.function.name,
            args,
          } as AiToolCall,
        };
      }
    }

    return { text: message.content || '' };
  }

  private getTools(): OpenAI.Chat.ChatCompletionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'create_jira_ticket',
          description:
            'Creates a Jira ticket for a bug, task, or issue based on the conversation.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description:
                  'A brief, concise summary or title for the Jira ticket.',
              },
              description: {
                type: 'string',
                description: 'A detailed description of the issue or task.',
              },
              priority: {
                type: 'string',
                enum: ['Lowest', 'Low', 'Medium', 'High', 'Highest'],
                description: 'Priority of the Jira ticket.',
              },
              bugId: {
                type: 'string',
                description: 'The BetterBugs bug or session ID if available from context.',
              },
            },
            required: ['summary', 'description'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'assign_bug',
          description:
            'Assigns the BetterBugs report or task to a team member by email, name, or Slack user mention.',
          parameters: {
            type: 'object',
            properties: {
              bugId: {
                type: 'string',
                description: 'The BetterBugs bug or session ID (e.g., bug-abc123). If not provided, infer from thread context.',
              },
              assignee: {
                type: 'string',
                description: 'Name or email of the teammate to assign the bug to.',
              },
              slackUserId: {
                type: 'string',
                description: 'Slack user ID if the user was mentioned (e.g., U12345678).',
              },
              comment: {
                type: 'string',
                description: 'Optional note or assignment reason.',
              },
            },
            required: ['assignee'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_bug_comment',
          description:
            'Adds a comment, reproduction note, or message to the BetterBugs report, optionally mentioning team members.',
          parameters: {
            type: 'object',
            properties: {
              bugId: {
                type: 'string',
                description: 'The BetterBugs bug or session ID. If not provided, infer from thread context.',
              },
              comment: {
                type: 'string',
                description: 'The comment or note to attach to the bug report.',
              },
              mentions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Emails, names, or Slack IDs of teammates to mention in the comment.',
              },
            },
            required: ['comment'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_bug_status',
          description:
            'Updates the status (OPEN, IN_PROGRESS, CLOSED) or priority (LOW, MEDIUM, HIGH, URGENT) of the BetterBugs report.',
          parameters: {
            type: 'object',
            properties: {
              bugId: {
                type: 'string',
                description: 'The BetterBugs bug or session ID. If not provided, infer from thread context.',
              },
              status: {
                type: 'string',
                enum: ['OPEN', 'IN_PROGRESS', 'CLOSED'],
                description: 'The new status of the bug.',
              },
              priority: {
                type: 'string',
                enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
                description: 'The new priority of the bug.',
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_reminder',
          description:
            'Schedules a reminder or follow-up task to be executed at a specific time.',
          parameters: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description:
                  'The content of the reminder (e.g., "Review the PR").',
              },
              scheduledAt: {
                type: 'string',
                description:
                  'The scheduled time in ISO 8601 format (e.g., "2023-11-01T10:00:00Z"). Calculate this based on the user request and current time.',
              },
            },
            required: ['message', 'scheduledAt'],
          },
        },
      },
    ];
  }
}
