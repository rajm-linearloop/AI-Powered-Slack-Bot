export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },

  ai: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.AI_MODEL ?? 'openai/gpt-4o-mini',
    maxContextMessages: parseInt(
      process.env.AI_MAX_CONTEXT_MESSAGES ?? '20',
      10,
    ),
  },

  jira: {
    baseUrl: process.env.JIRA_BASE_URL ?? '',
    email: process.env.JIRA_EMAIL ?? '',
    apiToken: process.env.JIRA_API_TOKEN ?? '',
    projectKey: process.env.JIRA_PROJECT_KEY ?? '',
  },

  betterbugs: {
    mcpUrl: process.env.BETTERBUGS_MCP_URL ?? 'http://localhost:3001/mcp',
    mcpToken: process.env.BETTERBUGS_MCP_TOKEN ?? '',
  },

  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '20', 10),
  },
});
