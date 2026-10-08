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
  // Use a good open-source or free model on OpenRouter, like Meta's Llama 3 or Google's Gemini Flash via OpenRouter
  // google/gemini-2.5-flash is extremely fast, cheap, and supports tool calling on OpenRouter
  private readonly modelName = 'google/gemini-2.5-flash';

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('ai.apiKey');
    this.openai = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: apiKey,
    });
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
      max_tokens: 4000,
    };

    if (useTools) {
      requestOptions.tools = this.getTools();
      requestOptions.tool_choice = 'auto';
    }

    try {
      const response =
        await this.openai.chat.completions.create(requestOptions);
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
            },
            required: ['summary', 'description'],
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
