import { describe, it, expect } from 'vitest';
import { TelemetrySanitizer } from './telemetry-sanitizer.js';

describe('TelemetrySanitizer', () => {
  it('should redact Bearer authorization tokens', () => {
    const raw = 'Request header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz123';
    const clean = TelemetrySanitizer.redactString(raw);
    expect(clean).toContain('Bearer [REDACTED_TOKEN]');
    expect(clean).not.toContain('eyJhbGciOiJIUzI1Ni');
  });

  it('should redact passwords and secrets in JSON payloads', () => {
    const json = '{"username":"admin","password":"SuperSecretPassword123!","token":"abc-xyz-token"}';
    const clean = TelemetrySanitizer.redactString(json);
    expect(clean).toContain('"password":"[REDACTED_SECRET]"');
    expect(clean).toContain('"token":"[REDACTED_TOKEN]"');
    expect(clean).not.toContain('SuperSecretPassword123!');
  });

  it('should redact cookies and session identifiers', () => {
    const raw = 'Cookie: connect.sid=s%3A123456789.abcdef; session_id=sess_998877';
    const clean = TelemetrySanitizer.redactString(raw);
    expect(clean).toContain('Cookie: [REDACTED_COOKIE]');
    expect(clean).not.toContain('s%3A123456789');
  });

  it('should redact credit card numbers', () => {
    const raw = 'Payment error with card 4111 2222 3333 4444 in checkout';
    const clean = TelemetrySanitizer.redactString(raw);
    expect(clean).toContain('[REDACTED_CARD]');
    expect(clean).not.toContain('4111 2222 3333 4444');
  });

  it('should filter out 200 OK static asset requests and preserve failing requests', () => {
    const requests = [
      { url: 'https://cdn.example.com/logo.png', status: 200 },
      { url: 'https://cdn.example.com/styles.css', status: 200 },
      { url: 'https://cdn.example.com/font.woff2', status: 200 },
      { url: 'https://api.example.com/v1/checkout', status: 500 },
      { url: 'https://api.example.com/v1/cart', status: 200 },
    ];

    const filtered = TelemetrySanitizer.filterNetworkRequests(requests);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((r) => r.url)).toEqual([
      'https://api.example.com/v1/checkout',
      'https://api.example.com/v1/cart',
    ]);
  });

  it('should recursively sanitize objects and arrays', () => {
    const payload = {
      user: {
        name: 'Alice',
        password: 'secret_value',
      },
      headers: ['Authorization: Bearer my-token-123', 'Content-Type: application/json'],
    };

    const sanitized = TelemetrySanitizer.sanitizeObject(payload);
    expect(sanitized.user.password).toBe('[REDACTED_SECRET]');
    expect(sanitized.headers[0]).toContain('Bearer [REDACTED_TOKEN]');
    expect(sanitized.user.name).toBe('Alice');
  });
});
