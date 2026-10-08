export enum MessageRole {
  User = 'user',
  Assistant = 'assistant',
}

export enum WorkflowType {
  Reminder = 'reminder',
  FollowUp = 'follow_up',
}

export enum WorkflowStatus {
  Pending = 'pending',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export interface SlackEventPayload {
  token: string;
  team_id: string;
  event: {
    type: string;
    subtype?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    channel: string;
    channel_type?: string;
    ts: string;
    thread_ts?: string;
    event_ts: string;
  };
  event_id: string;
  type: string;
  challenge?: string;
}

export interface SlackCommandPayload {
  token: string;
  team_id: string;
  channel_id: string;
  user_id: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  thread_ts?: string;
}

export interface ContextMessage {
  role: MessageRole;
  content: string;
}

export type AiToolCall =
  | {
      tool: 'create_jira_ticket';
      args: {
        summary: string;
        description: string;
      };
    }
  | {
      tool: 'create_reminder';
      args: {
        message: string;
        scheduledAt: string;
      };
    };

export interface AiResponse {
  text: string;
  toolCall?: AiToolCall;
}
