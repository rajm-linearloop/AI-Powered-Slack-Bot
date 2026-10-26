import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { TriageService } from './triage.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import { SlackApiService } from '../../slack/slack-api.service.js';
import { BetterBugsService } from './betterbugs.service.js';
import { JiraService } from '../jira/jira.service.js';
import { WorkflowService } from '../../workflows/workflow.service.js';

describe('TriageService', () => {
  let service: TriageService;
  let prisma: PrismaService;
  let slackApi: SlackApiService;
  let betterBugsService: BetterBugsService;
  let jiraService: JiraService;
  let workflowService: WorkflowService;

  const mockPrisma = {
    jiraTicket: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };

  const mockSlackApi = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getUserProfile: vi.fn().mockResolvedValue({
      real_name: 'Jane Engineer',
      display_name: 'Jane',
      email: 'jane@company.com',
    }),
  };

  const mockBetterBugsService = {
    updateBugDetails: vi.fn().mockResolvedValue({ success: true }),
    listBugs: vi.fn().mockResolvedValue([
      { id: 'bb-101', title: 'Payment timeout on 3DS', status: 'open', priority: 'high' },
      { id: 'bb-102', title: 'Navbar misaligned in Safari', status: 'closed', priority: 'low' },
    ]),
  };

  const mockJiraService = {
    createTicket: vi.fn().mockResolvedValue({
      ticketKey: 'ENG-404',
      summary: 'Payment timeout issue',
    }),
    getTicketUrl: vi.fn().mockReturnValue('https://company.atlassian.net/browse/ENG-404'),
  };

  const mockWorkflowService = {
    createReminder: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPrisma.jiraTicket.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TriageService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SlackApiService, useValue: mockSlackApi },
        { provide: BetterBugsService, useValue: mockBetterBugsService },
        { provide: JiraService, useValue: mockJiraService },
        { provide: WorkflowService, useValue: mockWorkflowService },
      ],
    }).compile();

    service = module.get<TriageService>(TriageService);
    prisma = module.get<PrismaService>(PrismaService);
    slackApi = module.get<SlackApiService>(SlackApiService);
    betterBugsService = module.get<BetterBugsService>(BetterBugsService);
    jiraService = module.get<JiraService>(JiraService);
    workflowService = module.get<WorkflowService>(WorkflowService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createJiraTicket', () => {
    it('should create a Jira ticket and return confirmation link', async () => {
      const result = await service.createJiraTicket({
        bugId: 'bb-101',
        summary: 'Payment timeout issue',
        description: 'Session: https://app.betterbugs.io/session/bb-101',
        channelId: 'C100',
        workspaceId: 'W100',
        threadTs: '1000.1',
      });

      expect(jiraService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Payment timeout issue',
        }),
      );
      expect(result).toContain('Created Jira ticket *ENG-404*');
      expect(result).toContain('https://company.atlassian.net/browse/ENG-404');
    });

    it('should prevent duplicate Jira ticket creation if already created in thread', async () => {
      mockPrisma.jiraTicket.findFirst.mockResolvedValueOnce({
        ticketKey: 'ENG-404',
      });

      const result = await service.createJiraTicket({
        bugId: 'bb-101',
        summary: 'Payment timeout issue',
        description: 'test',
        channelId: 'C100',
        workspaceId: 'W100',
        threadTs: '1000.1',
      });

      expect(jiraService.createTicket).not.toHaveBeenCalled();
      expect(result).toContain('has already been created for this discussion');
    });

    it('should prevent duplicate Jira ticket creation if already created for bug session', async () => {
      mockPrisma.jiraTicket.findFirst
        .mockResolvedValueOnce(null) // thread check
        .mockResolvedValueOnce({ ticketKey: 'ENG-404' }); // bugId check

      const result = await service.createJiraTicket({
        bugId: 'bb-101',
        summary: 'Payment timeout issue',
        description: 'test',
        channelId: 'C100',
        workspaceId: 'W100',
        threadTs: '1000.2',
      });

      expect(jiraService.createTicket).not.toHaveBeenCalled();
      expect(result).toContain('has already been created for BetterBugs session *#bb-101*');
    });
  });

  describe('assignBug', () => {
    it('should resolve Slack user ID, update BetterBugs, and send private DM to assignee', async () => {
      const result = await service.assignBug({
        bugId: 'bb-101',
        assignee: '<@U999>',
        actorUserId: 'U111',
      });

      expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
        expect.objectContaining({
          bugId: 'bb-101',
          assignee: 'jane@company.com',
        }),
      );
      expect(slackApi.sendMessage).toHaveBeenCalledWith(
        'U999',
        expect.stringContaining('You have been assigned to BetterBugs session *#bb-101*'),
      );
      expect(result).toContain('Assigned BetterBugs session *#bb-101* to *Jane Engineer* (<@U999>)');
    });

    it('should handle external workspace write permission restriction gracefully', async () => {
      (betterBugsService.updateBugDetails as any).mockResolvedValueOnce({
        error: 'WORKSPACE_PERMISSION_DENIED',
      });

      const result = await service.assignBug({
        bugId: 'bb-101',
        assignee: 'developer@example.com',
      });

      expect(result).toContain('BetterBugs dashboard sync skipped: session belongs to an external workspace');
    });
  });

  describe('addComment', () => {
    it('should add comment and notify mentioned Slack teammates via DM', async () => {
      const result = await service.addComment({
        bugId: 'bb-101',
        comment: 'Please check this fix <@U999>',
        mentions: ['U999'],
        actorUserId: 'U111',
      });

      expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
        expect.objectContaining({
          bugId: 'bb-101',
          mentions: ['jane@company.com'],
        }),
      );
      expect(slackApi.sendMessage).toHaveBeenCalledWith(
        'U999',
        expect.stringContaining('You were mentioned in a comment on BetterBugs session *#bb-101*'),
      );
      expect(result).toContain('Added comment to BetterBugs session *#bb-101*');
    });
  });

  describe('updateStatus', () => {
    it('should update status and priority', async () => {
      const result = await service.updateStatus({
        bugId: 'bb-101',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
      });

      expect(betterBugsService.updateBugDetails).toHaveBeenCalledWith(
        expect.objectContaining({
          bugId: 'bb-101',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
        }),
      );
      expect(result).toContain('Updated BetterBugs session *#bb-101* status to *IN_PROGRESS* and priority to *HIGH*');
    });
  });

  describe('getBugDigest', () => {
    it('should return a formatted list of open bugs with links', async () => {
      const digest = await service.getBugDigest(undefined, 5);

      expect(betterBugsService.listBugs).toHaveBeenCalledWith(undefined, 5);
      expect(digest).toContain('BetterBugs Engineering Bug Digest (Top 2)');
      expect(digest).toContain('1. *#bb-101*: Payment timeout on 3DS [HIGH] (OPEN)');
      expect(digest).toContain('https://app.betterbugs.io/session/bb-101');
      expect(digest).toContain('2. *#bb-102*: Navbar misaligned in Safari [LOW] (CLOSED)');
    });

    it('should handle empty bug list gracefully', async () => {
      (betterBugsService.listBugs as any).mockResolvedValueOnce([]);

      const digest = await service.getBugDigest();
      expect(digest).toBe('No active bugs found in BetterBugs for this project.');
    });
  });

  describe('extractBugIdFromContext', () => {
    it('should extract bugId from session URL in text', () => {
      const bugId = service.extractBugIdFromContext([], 'Check https://app.betterbugs.io/session/bug-xyz999');
      expect(bugId).toBe('bug-xyz999');
    });

    it('should extract bugId from hashtag in context history', () => {
      const bugId = service.extractBugIdFromContext([
        { role: 'user' as any, content: 'Can we triage #bug-hash123 please?' },
      ]);
      expect(bugId).toBe('bug-hash123');
    });
  });
});
