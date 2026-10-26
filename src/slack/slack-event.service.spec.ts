import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SlackEventService } from './slack-event.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { AiService } from '../ai/ai.service.js';
import { RcaService } from '../ai/rca.service.js';
import { JiraService } from '../integrations/jira/jira.service.js';
import { BetterBugsService } from '../integrations/betterbugs/betterbugs.service.js';
import { BetterBugsLinkParser } from '../integrations/betterbugs/betterbugs-link.parser.js';
import { WorkflowService } from '../workflows/workflow.service.js';
import { SlackApiService } from './slack-api.service.js';

// Mock ioredis as an ES6 class
vi.mock('ioredis', () => {
  return {
    Redis: class MockRedis {
      set = vi.fn().mockResolvedValue('OK');
      get = vi.fn().mockResolvedValue(null);
    },
  };
});

describe('SlackEventService (Full Capabilities Test)', () => {
  let service: SlackEventService;
  let slackApi: SlackApiService;
  let rcaService: RcaService;
  let aiService: AiService;
  let jiraService: JiraService;
  let betterBugsService: BetterBugsService;
  let workflowService: WorkflowService;
  let conversationService: ConversationService;

  beforeEach(async () => {
    const mockPrisma = {
      processedEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'pe-1' }),
      },
    };

    const mockConfigService = {
      getOrThrow: vi.fn((key: string) => {
        if (key === 'redis.host') return 'localhost';
        if (key === 'redis.port') return 6379;
        return '';
      }),
      get: vi.fn().mockReturnValue(null),
    };

    const mockSlackApi = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendEphemeral: vi.fn().mockResolvedValue(undefined),
      getBotUserId: vi.fn().mockResolvedValue('UBOT123'),
      getUserProfile: vi.fn().mockResolvedValue({
        real_name: 'Alex Developer',
        display_name: 'Alex',
        email: 'alex@company.com',
      }),
    };

    const mockConversationService = {
      findOrCreateWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1', teamId: 'T123' }),
      findOrCreateUser: vi.fn().mockResolvedValue({ id: 'usr-1', slackUserId: 'U123' }),
      findOrCreateConversation: vi.fn().mockResolvedValue({ id: 'conv-1' }),
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      buildContext: vi.fn().mockResolvedValue([
        { role: 'user', content: 'Investigating bug https://app.betterbugs.io/session/bug-abc123' },
      ]),
    };

    const mockAiService = {
      generateResponse: vi.fn(),
    };

    const mockRcaService = {
      analyze: vi.fn().mockResolvedValue({
        summary: 'Checkout crashed due to missing zip property',
        rootCause: 'Validation error: address.zip is undefined',
        evidence: "TypeError: Cannot read properties of undefined (reading 'zip')",
        suggestedFix: 'Add optional chaining address?.zip',
        confidence: 'HIGH',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: 'BetterBugs RCA — Checkout Failure' } },
        ],
        fallbackText: 'BetterBugs RCA for #bug-abc123: Checkout crashed due to missing zip property',
      }),
    };

    const mockJiraService = {
      createTicket: vi.fn().mockResolvedValue({
        ticketKey: 'PROJ-101',
        summary: 'Checkout failure',
      }),
      getTicketUrl: vi.fn().mockReturnValue('https://jira.company.com/browse/PROJ-101'),
    };

    const mockBetterBugsService = {
      fetchFullInvestigation: vi.fn().mockResolvedValue({
        bugId: 'bug-abc123',
        details: { id: 'bug-abc123', title: 'Checkout failure' },
        logs: { consoleLogs: [], networkRequests: [] },
      }),
      updateBugDetails: vi.fn().mockResolvedValue({ success: true }),
    };

    const mockWorkflowService = {
      createReminder: vi.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlackEventService,
        BetterBugsLinkParser,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SlackApiService, useValue: mockSlackApi },
        { provide: ConversationService, useValue: mockConversationService },
        { provide: AiService, useValue: mockAiService },
        { provide: RcaService, useValue: mockRcaService },
        { provide: JiraService, useValue: mockJiraService },
        { provide: BetterBugsService, useValue: mockBetterBugsService },
        { provide: WorkflowService, useValue: mockWorkflowService },
      ],
    }).compile();

    service = module.get<SlackEventService>(SlackEventService);
    slackApi = module.get<SlackApiService>(SlackApiService);
    rcaService = module.get<RcaService>(RcaService);
    aiService = module.get<AiService>(AiService);
    jiraService = module.get<JiraService>(JiraService);
    betterBugsService = module.get<BetterBugsService>(BetterBugsService);
    workflowService = module.get<WorkflowService>(WorkflowService);
    conversationService = module.get<ConversationService>(ConversationService);
  });

  it('1. RCA Flow: should detect BetterBugs session link and post RCA Block Kit card', async () => {
    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-1',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> check this bug https://app.betterbugs.io/session/bug-abc123',
        ts: '1000.1',
        event_ts: '1000.1',
      },
    });

    // Fast ACK was sent
    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Investigating BetterBugs session `#bug-abc123`'),
      '1000.1',
    );

    // RCA was analyzed
    expect(betterBugsService.fetchFullInvestigation).toHaveBeenCalledWith('bug-abc123');
    expect(rcaService.analyze).toHaveBeenCalled();

    // RCA Block Kit card was sent
    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('BetterBugs RCA for #bug-abc123'),
      '1000.1',
      expect.any(Array),
    );
  });

  it('2. Jira Flow: should create Jira ticket linked to thread bug context', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'Creating Jira ticket...',
      toolCall: {
        tool: 'create_jira_ticket',
        args: {
          summary: 'Checkout crashed when shipping address missing zip',
          description: 'TypeError on checkout submit',
        },
      },
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-2',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> create a jira ticket for this bug',
        ts: '1000.2',
        thread_ts: '1000.1',
        event_ts: '1000.2',
      },
    });

    expect(jiraService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Checkout crashed when shipping address missing zip',
        description: expect.stringContaining('https://app.betterbugs.io/session/bug-abc123'),
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Created Jira ticket *PROJ-101*'),
      '1000.1',
    );
  });

  it('3. Assign Flow: should resolve Slack user mention to email and assign bug in BetterBugs', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'Assigning bug...',
      toolCall: {
        tool: 'assign_bug',
        args: {
          assignee: 'Alex',
          slackUserId: 'U9999',
        },
      },
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-3',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> assign this bug to <@U9999>',
        ts: '1000.3',
        thread_ts: '1000.1',
        event_ts: '1000.3',
      },
    });

    expect(slackApi.getUserProfile).toHaveBeenCalledWith('U9999');
    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        assignee: 'alex@company.com',
        mentions: ['U9999'],
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Assigned BetterBugs session *#bug-abc123* to *Alex Developer* (<@U9999>)'),
      '1000.1',
    );
  });

  it('4. Comment Flow: should add comment with mentions to BetterBugs report', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'Adding comment...',
      toolCall: {
        tool: 'add_bug_comment',
        args: {
          comment: 'Reproduction confirmed on Chrome 130 <@U9999>',
        },
      },
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-4',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> add comment: Reproduction confirmed on Chrome 130 <@U9999>',
        ts: '1000.4',
        thread_ts: '1000.1',
        event_ts: '1000.4',
      },
    });

    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        comment: 'Reproduction confirmed on Chrome 130 <@U9999>',
        mentions: ['alex@company.com'],
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Added comment to BetterBugs session *#bug-abc123* (mentioning <@U9999>):\n>Reproduction confirmed on Chrome 130 <@U9999>'),
      '1000.1',
    );
  });

  it('5. Status & Priority Flow: should update bug status and priority in BetterBugs', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'Updating bug...',
      toolCall: {
        tool: 'update_bug_status',
        args: {
          status: 'IN_PROGRESS',
          priority: 'URGENT',
        },
      },
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-5',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> mark status IN_PROGRESS and priority URGENT',
        ts: '1000.5',
        thread_ts: '1000.1',
        event_ts: '1000.5',
      },
    });

    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        status: 'IN_PROGRESS',
        priority: 'URGENT',
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      'Updated BetterBugs session *#bug-abc123* status to *IN_PROGRESS* and priority to *URGENT*.',
      '1000.1',
    );
  });

  it('6. Reminders Flow: should schedule a reminder via workflowService', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'Setting reminder...',
      toolCall: {
        tool: 'create_reminder',
        args: {
          message: 'Check PR review status',
          scheduledAt: '2026-10-15T15:00:00Z',
        },
      },
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-6',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> remind me to check PR review at 3pm',
        ts: '1000.6',
        thread_ts: '1000.1',
        event_ts: '1000.6',
      },
    });

    expect(workflowService.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Check PR review status',
        scheduledAt: '2026-10-15T15:00:00Z',
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Reminder set: "Check PR review status"'),
      '1000.1',
    );
  });

  it('7. Interactive Action: Create Jira Task button click', async () => {
    await service.processInteraction({
      type: 'block_actions',
      team: { id: 'T123' },
      user: { id: 'U123' },
      channel: { id: 'C123' },
      container: { thread_ts: '1000.1' },
      actions: [
        {
          action_id: 'action_create_jira_ticket',
          value: JSON.stringify({
            bugId: 'bug-abc123',
            title: 'Checkout Failure',
            rootCause: 'Cannot read properties of undefined (reading zip)',
          }),
        },
      ],
    });

    expect(jiraService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: '[BetterBugs #bug-abc123] Checkout Failure',
        description: expect.stringContaining('https://app.betterbugs.io/session/bug-abc123'),
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.stringContaining('Created Jira ticket *PROJ-101*'),
      '1000.1',
    );
  });

  it('8. Interactive Action: Assign to Me button click', async () => {
    await service.processInteraction({
      type: 'block_actions',
      team: { id: 'T123' },
      user: { id: 'U123' },
      channel: { id: 'C123' },
      container: { thread_ts: '1000.1' },
      actions: [
        {
          action_id: 'action_assign_to_me',
          value: JSON.stringify({
            bugId: 'bug-abc123',
          }),
        },
      ],
    });

    expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        bugId: 'bug-abc123',
        assignee: 'alex@company.com',
        mentions: ['U123'],
      }),
    );

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      'Assigned BetterBugs session *#bug-abc123* to <@U123>.',
      '1000.1',
    );
  });

  it('9. Technical Q&A: should answer technical questions directly without emojis', async () => {
    vi.spyOn(aiService, 'generateResponse').mockResolvedValue({
      text: 'OAuth 2.0 uses authorization codes to exchange tokens securely without exposing client secrets.',
    });

    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-9',
      type: 'event_callback',
      event: {
        type: 'app_mention',
        user: 'U123',
        channel: 'C123',
        text: '<@UBOT123> how does OAuth authorization code grant work?',
        ts: '1000.9',
        thread_ts: '1000.1',
        event_ts: '1000.9',
      },
    });

    expect(slackApi.sendMessage).toHaveBeenCalledWith(
      'C123',
      'OAuth 2.0 uses authorization codes to exchange tokens securely without exposing client secrets.',
      '1000.1',
    );
  });

  it('10. Bot Filtering: should ignore messages from bots to prevent recursive loops', async () => {
    await service.processEvent({
      token: 'tok',
      team_id: 'T123',
      event_id: 'evt-bot',
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B12345',
        channel: 'C123',
        text: 'This is a message from a bot',
        ts: '1000.99',
        event_ts: '1000.99',
      },
    });

    expect(aiService.generateResponse).not.toHaveBeenCalled();
    expect(slackApi.sendMessage).not.toHaveBeenCalled();
  });
});
