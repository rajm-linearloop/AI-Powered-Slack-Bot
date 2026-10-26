import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { CommandsService } from './commands.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { SlackApiService } from '../slack/slack-api.service.js';
import { JiraService } from '../integrations/jira/jira.service.js';
import { BetterBugsService } from '../integrations/betterbugs/betterbugs.service.js';
import { BetterBugsLinkParser } from '../integrations/betterbugs/betterbugs-link.parser.js';
import { WorkflowService } from '../workflows/workflow.service.js';

describe('CommandsService', () => {
  let service: CommandsService;
  let slackApi: SlackApiService;
  let jiraService: JiraService;
  let betterBugsService: BetterBugsService;

  beforeEach(async () => {
    const mockConversationService = {
      findOrCreateWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1', teamId: 'T123' }),
      findOrCreateUser: vi.fn().mockResolvedValue({ id: 'usr-1', slackUserId: 'U123' }),
      findOrCreateConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
      buildContext: vi.fn().mockResolvedValue([
        { role: 'user', content: 'Here is bug https://app.betterbugs.io/session/bug-abc123' },
      ]),
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
    };

    const mockAiService = {
      generateResponse: vi.fn(),
      summarize: vi.fn(),
      extractActionItems: vi.fn(),
    };

    const mockSlackApi = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendEphemeral: vi.fn().mockResolvedValue(undefined),
      getUserProfile: vi.fn().mockResolvedValue({
        real_name: 'Alex Developer',
        display_name: 'Alex',
        email: 'alex@company.com',
      }),
    };

    const mockJiraService = {
      createTicket: vi.fn().mockResolvedValue({ ticketKey: 'PROJ-101', summary: 'Checkout failure' }),
      getTicketUrl: vi.fn().mockReturnValue('https://jira.company.com/browse/PROJ-101'),
    };

    const mockBetterBugsService = {
      updateBugDetails: vi.fn().mockResolvedValue({ success: true }),
    };

    const mockWorkflowService = {
      createReminder: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommandsService,
        BetterBugsLinkParser,
        { provide: ConversationService, useValue: mockConversationService },
        { provide: AiService, useValue: mockAiService },
        { provide: SlackApiService, useValue: mockSlackApi },
        { provide: JiraService, useValue: mockJiraService },
        { provide: BetterBugsService, useValue: mockBetterBugsService },
        { provide: WorkflowService, useValue: mockWorkflowService },
      ],
    }).compile();

    service = module.get<CommandsService>(CommandsService);
    slackApi = module.get<SlackApiService>(SlackApiService);
    jiraService = module.get<JiraService>(JiraService);
    betterBugsService = module.get<BetterBugsService>(BetterBugsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should handle /jira command and create a Jira ticket with bug context', async () => {
    await service.executeCommand({
      token: 'tok',
      team_id: 'T123',
      channel_id: 'C123',
      user_id: 'U123',
      command: '/jira',
      text: 'Checkout crash on checkout page',
      response_url: 'https://hooks.slack.com/...',
      trigger_id: 'trig',
      thread_ts: '1234.5678',
    });

    expect(jiraService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Checkout crash on checkout page',
        description: expect.stringContaining('bug-abc123'),
      }),
    );
    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Created Jira ticket *PROJ-101*'),
      '1234.5678',
    );
  });

  it('should handle /assign command and resolve user profile to email', async () => {
    await service.executeCommand({
      token: 'tok',
      team_id: 'T123',
      channel_id: 'C123',
      user_id: 'U123',
      command: '/assign',
      text: '<@U99999>',
      response_url: 'https://hooks.slack.com/...',
      trigger_id: 'trig',
      thread_ts: '1234.5678',
    });

    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        assignee: 'alex@company.com',
      }),
    );
    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Assigned BetterBugs session *#bug-abc123* to *Alex Developer* (<@U99999>)'),
      '1234.5678',
    );
  });

  it('should handle /comment command with mentions', async () => {
    await service.executeCommand({
      token: 'tok',
      team_id: 'T123',
      channel_id: 'C123',
      user_id: 'U123',
      command: '/comment',
      text: 'Verified this fix on staging <@U99999>',
      response_url: 'https://hooks.slack.com/...',
      trigger_id: 'trig',
      thread_ts: '1234.5678',
    });

    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        comment: 'Verified this fix on staging <@U99999>',
        mentions: ['alex@company.com'],
      }),
    );
    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Added comment to BetterBugs session *#bug-abc123*'),
      '1234.5678',
    );
  });

  it('should handle /ask command and persist question and answer in conversation history', async () => {
    const mockAiService = (service as any).aiService;
    mockAiService.generateResponse.mockResolvedValueOnce({
      text: 'OAuth 2.0 is an authorization framework.',
    });

    await service.executeCommand({
      token: 'tok',
      team_id: 'T123',
      channel_id: 'C123',
      user_id: 'U123',
      command: '/ask',
      text: 'What is OAuth?',
      response_url: 'https://hooks.slack.com/...',
      trigger_id: 'trig',
      thread_ts: '1234.5678',
    });

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('OAuth 2.0 is an authorization framework.'),
      '1234.5678',
    );
    expect((service as any).conversationService.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should handle /summarize command and post summary in channel', async () => {
    const mockAiService = (service as any).aiService;
    mockAiService.summarize.mockResolvedValueOnce('Summary of discussion.');

    await service.executeCommand({
      token: 'tok',
      team_id: 'T123',
      channel_id: 'C123',
      user_id: 'U123',
      command: '/summarize',
      text: '',
      response_url: 'https://hooks.slack.com/...',
      trigger_id: 'trig',
      thread_ts: '1234.5678',
    });

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('*Thread Summary*\nSummary of discussion.'),
      '1234.5678',
    );
  });
});
