import { describe, it, expect } from 'vitest';
import { BetterBugsLinkParser } from './betterbugs-link.parser.js';

describe('BetterBugsLinkParser', () => {
  const parser = new BetterBugsLinkParser();

  it('should return hasLink false when no link is present', () => {
    const result = parser.parse('Hey @BetterBugs can you check the bot?');
    expect(result.hasLink).toBe(false);
    expect(result.bugId).toBeUndefined();
    expect(result.allLinks).toHaveLength(0);
  });

  it('should extract bugId from standard session URL', () => {
    const result = parser.parse(
      'Take a look at this bug: https://app.betterbugs.io/session/session-12345',
    );
    expect(result.hasLink).toBe(true);
    expect(result.bugId).toBe('session-12345');
    expect(result.url).toBe('https://app.betterbugs.io/session/session-12345');
  });

  it('should extract bugId from /bugs/ URL', () => {
    const result = parser.parse(
      'Bug found: https://app.betterbugs.io/bugs/bug-xyz890 please check',
    );
    expect(result.hasLink).toBe(true);
    expect(result.bugId).toBe('bug-xyz890');
    expect(result.url).toBe('https://app.betterbugs.io/session/bug-xyz890');
  });

  it('should handle Slack markdown formatted links <URL|label> and <URL>', () => {
    const result = parser.parse(
      'Check <https://app.betterbugs.io/session/bb-prod-404|BetterBugs Report> please',
    );
    expect(result.hasLink).toBe(true);
    expect(result.bugId).toBe('bb-prod-404');

    const result2 = parser.parse(
      'Check <https://app.betterbugs.io/session/bb-raw-999>',
    );
    expect(result2.hasLink).toBe(true);
    expect(result2.bugId).toBe('bb-raw-999');
  });

  it('should handle multiple links and deduplicate them', () => {
    const text =
      'First https://app.betterbugs.io/session/bug-1 and second https://app.betterbugs.io/bugs/bug-2 and repeat https://app.betterbugs.io/session/bug-1';
    const result = parser.parse(text);
    expect(result.hasLink).toBe(true);
    expect(result.isAmbiguous).toBe(true);
    expect(result.bugId).toBe('bug-1');
    expect(result.allLinks).toHaveLength(2);
    expect(result.allLinks[0].bugId).toBe('bug-1');
    expect(result.allLinks[1].bugId).toBe('bug-2');
  });
});
