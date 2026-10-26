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
        bugId?: string;
        priority?: string;
      };
    }
  | {
      tool: 'assign_bug';
      args: {
        bugId?: string;
        assignee: string;
        slackUserId?: string;
        priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
        comment?: string;
      };
    }
  | {
      tool: 'add_bug_comment';
      args: {
        bugId?: string;
        comment: string;
        mentions?: string[];
      };
    }
  | {
      tool: 'update_bug_status';
      args: {
        bugId?: string;
        status?: 'OPEN' | 'IN_PROGRESS' | 'CLOSED';
        priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
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
