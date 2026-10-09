import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service.js';
import { LlmProvider } from './llm.provider.js';
import { MessageRole } from '../common/types/index.js';

describe('AiService', () => {
  let aiService: AiService;
  let llmProvider: LlmProvider;

  beforeEach(async () => {
    // Mock the LlmProvider
    const mockLlmProvider = {
      generateContent: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: LlmProvider,
          useValue: mockLlmProvider,
        },
      ],
    }).compile();

    aiService = module.get<AiService>(AiService);
    llmProvider = module.get<LlmProvider>(LlmProvider);
  });

  it('should be defined', () => {
    expect(aiService).toBeDefined();
  });

  describe('summarize', () => {
    it('should return a summary without triggering tools', async () => {
      const mockContext = [{ role: MessageRole.User, content: 'Hello' }];
      vi.spyOn(llmProvider, 'generateContent').mockResolvedValue({
        text: 'This is a summary.',
      });

      const result = await aiService.summarize(mockContext);

      expect(result).toBe('This is a summary.');
      expect(llmProvider.generateContent).toHaveBeenCalledWith(
        expect.any(String), // SUMMARIZE_SYSTEM_PROMPT
        [],
        'Please summarize the following conversation:\n\nUSER: Hello',
        false, // tools disabled
      );
    });
  });

  describe('extractActionItems', () => {
    it('should return action items without triggering tools', async () => {
      const mockContext = [{ role: MessageRole.User, content: 'Fix the bug' }];
      vi.spyOn(llmProvider, 'generateContent').mockResolvedValue({
        text: '- [ ] Fix bug',
      });

      const result = await aiService.extractActionItems(mockContext);

      expect(result).toBe('- [ ] Fix bug');
      expect(llmProvider.generateContent).toHaveBeenCalledWith(
        expect.any(String), // ACTION_ITEMS_SYSTEM_PROMPT
        [],
        'Please extract action items from the following conversation:\n\nUSER: Fix the bug',
        false, // tools disabled
      );
    });
  });
});
