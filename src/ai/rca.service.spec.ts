import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { RcaService } from './rca.service.js';
import { LlmProvider } from './llm.provider.js';
import { InvestigationData } from '../integrations/betterbugs/betterbugs.service.js';

describe('RcaService', () => {
  let rcaService: RcaService;
  let llmProvider: LlmProvider;

  const mockInvestigation: InvestigationData = {
    bugId: 'bug-123',
    details: {
      id: 'bug-123',
      title: 'Checkout button crashes on submit',
      environment: {
        browser: 'Chrome 130',
        os: 'macOS 15',
      },
      url: 'https://app.betterbugs.io/session/bug-123',
      reproSteps: ['Click Checkout', 'Submit form'],
    },
    logs: {
      consoleLogs: [
        {
          level: 'error',
          message: "TypeError: Cannot read properties of undefined (reading 'zip')",
          stack: "TypeError: Cannot read properties of undefined (reading 'zip')\nat Checkout.tsx:42",
        },
      ],
      networkRequests: [
        {
          url: 'https://api.example.com/checkout',
          method: 'POST',
          status: 400,
          responseBody: '{"error": "zip required"}',
        },
      ],
    },
  };

  beforeEach(async () => {
    const mockLlmProvider = {
      generateContent: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RcaService,
        {
          provide: LlmProvider,
          useValue: mockLlmProvider,
        },
      ],
    }).compile();

    rcaService = module.get<RcaService>(RcaService);
    llmProvider = module.get<LlmProvider>(LlmProvider);
  });

  it('should be defined', () => {
    expect(rcaService).toBeDefined();
  });

  it('should analyze telemetry and return structured Block Kit blocks from LLM JSON', async () => {
    vi.spyOn(llmProvider, 'generateContent').mockResolvedValue({
      text: JSON.stringify({
        summary: 'Checkout crashed due to missing zip property',
        rootCause: "Validation failed because address.zip is undefined at Checkout.tsx:42",
        evidence: "TypeError: Cannot read properties of undefined (reading 'zip')",
        suggestedFix: 'Add optional chaining address?.zip or require zip in form validation.',
        confidence: 'HIGH',
      }),
    });

    const result = await rcaService.analyze(mockInvestigation);

    expect(result.summary).toBe('Checkout crashed due to missing zip property');
    expect(result.confidence).toBe('HIGH');
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.fallbackText).toContain('Checkout crashed');
  });

  it('should safely fall back if LLM does not return valid JSON', async () => {
    vi.spyOn(llmProvider, 'generateContent').mockResolvedValue({
      text: 'Here is some plain text that is not valid JSON.',
    });

    const result = await rcaService.analyze(mockInvestigation);

    expect(result.summary).toBe('Checkout button crashes on submit');
    expect(result.rootCause).toContain("TypeError: Cannot read properties of undefined");
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it('should return error notice when investigation data has error', async () => {
    const errorData: InvestigationData = {
      bugId: 'invalid-id',
      error: 'Session not found',
    };

    const result = await rcaService.analyze(errorData);

    expect(result.summary).toBe('Investigation failed');
    expect(result.rootCause).toContain('Session not found');
    expect(result.confidence).toBe('LOW');
  });

  it('should handle thin telemetry with low confidence and no hallucinated root cause', async () => {
    vi.spyOn(llmProvider, 'generateContent').mockResolvedValue({
      text: JSON.stringify({
        summary: 'Form submission with clean logs',
        rootCause: 'No active errors or failed network requests detected in the captured session telemetry.',
        evidence: 'All requests 200 OK',
        suggestedFix: 'Review backend APM logs.',
        confidence: 'LOW',
      }),
    });

    const thinData: InvestigationData = {
      bugId: 'thin-123',
      details: {
        id: 'thin-123',
        title: 'User claims page is slow',
        environment: { browser: 'Chrome 130', os: 'macOS 15' },
        url: 'https://app.betterbugs.io/session/thin-123',
      },
      logs: {
        consoleLogs: [],
        networkRequests: [
          { url: 'https://api.example.com/data', method: 'GET', status: 200 },
        ],
      },
    };

    const result = await rcaService.analyze(thinData);

    expect(result.confidence).toBe('LOW');
    expect(result.rootCause).toContain('No active errors');
  });
});
