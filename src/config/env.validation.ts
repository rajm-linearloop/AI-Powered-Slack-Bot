import Joi from 'joi';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  DATABASE_URL: Joi.string().uri().required(),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  SLACK_BOT_TOKEN: Joi.string().required(),
  SLACK_SIGNING_SECRET: Joi.string().required(),

  OPENROUTER_API_KEY: Joi.string().required(),

  // Jira is optional — bot works without it but logs a warning
  JIRA_BASE_URL: Joi.string().uri().allow('').optional().default(''),
  JIRA_EMAIL: Joi.string().allow('').optional().default(''),
  JIRA_API_TOKEN: Joi.string().allow('').optional().default(''),
  JIRA_PROJECT_KEY: Joi.string().allow('').optional().default(''),

  RATE_LIMIT_TTL: Joi.number().default(60),
  RATE_LIMIT_MAX: Joi.number().default(20),

  AI_MAX_CONTEXT_MESSAGES: Joi.number().default(20),
});
