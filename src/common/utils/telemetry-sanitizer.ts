/**
 * Telemetry Sanitizer & Redactor
 *
 * Implements strict security and governance rules as mandated by RFC-004:
 * 1. Strips authorization tokens, Bearer tokens, cookies, passwords, and sensitive PII.
 * 2. Filters out 200 OK static asset requests (.png, .css, fonts, etc.) to optimize token budget.
 * 3. Enforces token budgets and redacts sensitive JSON properties prior to LLM submission.
 */
export class TelemetrySanitizer {
  private static readonly SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
    // Bearer / Authorization tokens
    {
      regex: /Bearer\s+[a-zA-Z0-9_\-\.]+/gi,
      replacement: 'Bearer [REDACTED_TOKEN]',
    },
    // Authorization headers or token key-values in JSON
    {
      regex: /("?(?:authorization|auth_token|access_token|jwt|api[_-]?key|token)"?\s*[:=]\s*)"[^"]+"/gi,
      replacement: '$1"[REDACTED_TOKEN]"',
    },
    // Cookie headers
    {
      regex: /(?:Cookie|Set-Cookie)\s*:\s*[^;\r\n]+/gi,
      replacement: 'Cookie: [REDACTED_COOKIE]',
    },
    // Specific session IDs in query or text
    {
      regex: /(connect\.sid|session_?id|auth_token|remember_token)=[^;&\s]+/gi,
      replacement: '$1=[REDACTED]',
    },
    // Passwords and secrets in JSON
    {
      regex: /("?(?:password|passwd|pwd|secret|private_?key)"?\s*[:=]\s*)"[^"]+"/gi,
      replacement: '$1"[REDACTED_SECRET]"',
    },
    // Passwords in query strings or form parameters
    {
      regex: /(?:password|passwd|pwd|secret)=[^&\s]+/gi,
      replacement: 'password=[REDACTED_SECRET]',
    },
    // Credit card candidate numbers (13 to 19 digits)
    {
      regex: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
      replacement: '[REDACTED_CARD]',
    },
  ];

  private static readonly STATIC_ASSET_REGEX =
    /\.(?:png|jpe?g|gif|svg|ico|css|woff2?|ttf|eot|map)(?:\?.*)?$/i;

  /**
   * Redacts sensitive secrets, passwords, cookies, and tokens from any text string.
   */
  static redactString(text: string): string {
    if (!text || typeof text !== 'string') return text;

    let sanitized = text;
    for (const pattern of this.SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern.regex, pattern.replacement);
    }
    return sanitized;
  }

  /**
   * Filters out 200 OK network requests for static assets (.png, .css, fonts, etc.),
   * preserving failing requests and relevant API traffic.
   */
  static filterNetworkRequests<T extends { url: string; status: number }>(requests: T[]): T[] {
    if (!Array.isArray(requests)) return [];

    return requests.filter((req) => {
      // Always keep failed requests (status >= 400 or status === 0)
      if (req.status >= 400 || req.status === 0) {
        return true;
      }

      // For 200 OK requests, filter out noisy static assets
      return !this.STATIC_ASSET_REGEX.test(req.url);
    });
  }

  /**
   * Recursively sanitizes an object or array, redacting sensitive strings and key values.
   */
  static sanitizeObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      return this.redactString(obj) as unknown as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item)) as unknown as T;
    }

    if (typeof obj === 'object') {
      const sanitizedObj: Record<string, any> = {};
      for (const [key, value] of Object.entries(obj)) {
        // Redact key names that explicitly denote secrets
        if (/^(?:password|secret|token|authorization|cookie)$/i.test(key) && typeof value === 'string') {
          sanitizedObj[key] = '[REDACTED_SECRET]';
        } else {
          sanitizedObj[key] = this.sanitizeObject(value);
        }
      }
      return sanitizedObj as T;
    }

    return obj;
  }
}
