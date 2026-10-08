import { Injectable, Logger } from '@nestjs/common';
import { LlmProvider } from './llm.provider.js';
import {
  GENERAL_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  ACTION_ITEMS_SYSTEM_PROMPT,
} from './system-prompts.js';
import { ContextMessage, AiResponse } from '../common/types/index.js';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly llmProvider: LlmProvider) {}

  /**
   * Generates a standard conversational response, optionally triggering tool calls.
   */
  async generateResponse(
    userMessage: string,
    context: ContextMessage[],
  ): Promise<AiResponse> {
    this.logger.debug('Generating response for user message');

    // Make sure the assistant knows the current time so it can schedule reminders properly
    const systemPromptWithTime = `${GENERAL_SYSTEM_PROMPT}\n\nThe current date and time is: ${new Date().toISOString()}`;

    return this.llmProvider.generateContent(
      systemPromptWithTime,
      context,
      userMessage,
      true, // useTools
    );
  }

  /**
   * Summarizes a conversation context. Does not trigger tools.
   */
  async summarize(context: ContextMessage[]): Promise<string> {
    this.logger.debug('Generating summary for conversation');
    
    // Convert the chat history into a single text block
    const transcript = context
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const response = await this.llmProvider.generateContent(
      SUMMARIZE_SYSTEM_PROMPT,
      [], // Pass empty context since we stringified it
      `Please summarize the following conversation:\n\n${transcript}`,
      false, // useTools
    );
    return response.text;
  }

  /**
   * Extracts action items from a conversation context. Does not trigger tools.
   */
  async extractActionItems(context: ContextMessage[]): Promise<string> {
    this.logger.debug('Extracting action items from conversation');
    
    const transcript = context
      .map((msg) => `${msg.role.toUpperCase()}: ${msg.content}`)
      .join('\n\n');

    const response = await this.llmProvider.generateContent(
      ACTION_ITEMS_SYSTEM_PROMPT,
      [], // Pass empty context since we stringified it
      `Please extract action items from the following conversation:\n\n${transcript}`,
      false, // useTools
    );
    return response.text;
  }
}
