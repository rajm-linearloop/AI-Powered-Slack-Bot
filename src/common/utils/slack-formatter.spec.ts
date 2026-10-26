import { describe, it, expect } from 'vitest';
import { formatSlackMrkdwn } from './slack-formatter.js';

describe('formatSlackMrkdwn', () => {
  it('converts double asterisks bold to single asterisk for Slack', () => {
    const input = '1. **Roles**:\n   - **Resource Owner**: The user.';
    const expected = '1. *Roles*:\n   - *Resource Owner*: The user.';
    expect(formatSlackMrkdwn(input)).toBe(expected);
  });

  it('converts markdown headers to bold for Slack', () => {
    const input = '### Key Concepts\n## Overview\n# Main Title';
    const expected = '*Key Concepts*\n*Overview*\n*Main Title*';
    expect(formatSlackMrkdwn(input)).toBe(expected);
  });

  it('converts markdown links to Slack mrkdwn links', () => {
    const input = 'Check out [BetterBugs](https://betterbugs.io) for logs.';
    const expected = 'Check out <https://betterbugs.io|BetterBugs> for logs.';
    expect(formatSlackMrkdwn(input)).toBe(expected);
  });

  it('preserves code blocks and inline code unchanged', () => {
    const input = 'Here is code:\n```typescript\nconst a = 2 ** 3;\n```\nAnd inline `**not bold**`.';
    expect(formatSlackMrkdwn(input)).toBe(input);
  });

  it('handles empty or null string gracefully', () => {
    expect(formatSlackMrkdwn('')).toBe('');
  });
});
