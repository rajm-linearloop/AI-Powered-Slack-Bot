# AI-Powered Slack Bot

An enterprise-grade Slack assistant built with **NestJS, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, and LLM tool calling**.

This bot integrates directly with the Slack Events API to provide conversational AI, thread-aware context, conversation summarization, Jira ticket creation, and workflow automation.

---

## System Architecture

The backend uses a modular architecture, separating Slack communication, AI processing, BetterBugs MCP telemetry ingestion, Jira ticketing, and persistence into isolated NestJS modules.

- **API Layer**: NestJS REST endpoints and Slack webhook receivers with signature verification (`SlackSignatureGuard`) and rate limiting (`RateLimitGuard`).
- **BetterBugs Integration**: Connects via Model Context Protocol (MCP) to fetch bug details, console errors, failed HTTP 4xx/5xx requests, and user click actions.
- **AI & RCA Engine**: Autonomous Root Cause Analysis (RCA) providing concise failure summaries, log evidence traces, suggested fixes, and executive Slack Block Kit cards.
- **Persistence**: PostgreSQL (via Prisma ORM) for users, channels, thread message histories, and Jira ticket associations.
- **Caching & Queueing**: Redis for sub-3s event idempotency (`SET NX`) and BullMQ for delayed workflow automation (e.g., Slack reminders).
- **Atlassian Jira Integration**: Formats Atlassian Document Format (ADF) payloads to file real Jira tasks directly from Slack threads.

```mermaid
flowchart TB
    Slack["Slack Events & Block Kit"] --> NestJS["NestJS Backend"]
    NestJS --> BetterBugs["BetterBugs MCP Server"]
    NestJS --> LLM["LLM Provider (OpenRouter)"]
    NestJS --> Jira["Jira REST API"]
    NestJS --> PostgreSQL["PostgreSQL (Prisma)"]
    NestJS --> Redis["Redis (Cache/Idempotency)"]
    NestJS --> BullMQ["BullMQ (Background Jobs)"]
```

### Workflows

1. **Autonomous RCA Pipeline:**
   `Slack Session URL` ➡️ `Webhook Guard` ➡️ `Fast ACK (<3s)` ➡️ `BetterBugs MCP (Telemetry Fetch)` ➡️ `Security Sanitizer (PII/Token Scrubbing)` ➡️ `RCA Engine` ➡️ `Interactive Block Kit Card`
2. **Conversational Triage & Jira Tool Calling:**
   `Slack Thread Mention` ➡️ `AI Intent & Tool Call Detection` ➡️ `Jira REST API / BetterBugs Update` ➡️ `Save Ticket to PostgreSQL` ➡️ `Private Assignee Slack DM`
3. **Background Job Automation (Reminders):**
   `Schedule Request` ➡️ `BullMQ Delayed Queue (Redis)` ➡️ `Delayed Execution` ➡️ `Slack Thread Notification`

---

## Key Features

1. **Intelligent Conversation**
   - Supports Direct Messages, `@Bot` channel mentions, and thread replies.
   - Maintains continuous thread context by retrieving recent message history from PostgreSQL.
2. **Slash Commands**
   - `/ask <question>`: Query the AI directly.
   - `/summarize`: Generates a concise summary of the current thread.
   - `/action-items`: Extracts tasks and action items from the discussion.
3. **Jira Integration (Tool Calling)**
   - The AI can automatically detect bug reports or task requests and trigger a structured JSON tool call.
   - The backend validates the request and creates a live ticket via the Jira REST API, returning the ticket link to Slack.
4. **Workflow Automation**
   - Users can ask the bot to set reminders (e.g., `"Remind me to check this in 10 minutes"`).
   - The backend schedules a delayed BullMQ job in Redis which fires back a Slack notification at the exact requested time.
5. **Reliability & Security**
   - **Idempotency**: Prevents processing duplicate Slack event retries using atomic Redis claims.
   - **Rate Limiting**: Throttles excessive requests.
   - **Multi-Workspace**: Dynamically partitions data and channels using Slack `team_id`.

---

## Setup Instructions

### 1. Prerequisites
- Node.js (v24+)
- Docker & Docker Compose
- ngrok (for Slack event tunneling)

### 2. Environment Configuration
Create a `.env` file in the root directory:

```env
# Server
NODE_ENV=development
PORT=3000

# Database (PostgreSQL)
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/slackbot?schema=public"

# Redis
REDIS_HOST="localhost"
REDIS_PORT="6379"

# Slack
SLACK_BOT_TOKEN="xoxb-your-bot-token"
SLACK_SIGNING_SECRET="your-signing-secret"

# AI
OPENROUTER_API_KEY="your-llm-api-key"
AI_MAX_CONTEXT_MESSAGES="20"

# Jira Integration
JIRA_BASE_URL="https://your-domain.atlassian.net"
JIRA_EMAIL="your-email@example.com"
JIRA_API_TOKEN="your-jira-token"
JIRA_PROJECT_KEY="PROJ"
```

### 3. Start Infrastructure
Run the required PostgreSQL and Redis containers:
```bash
docker compose up -d
```

### 4. Database Initialization
Push the Prisma schema to the database and generate the client:
```bash
npx prisma generate
npx prisma db push
```

### 5. Start the Application
Install dependencies and run the NestJS server:
```bash
npm install
npm run start:dev
```

### 6. Connect Slack (ngrok)
Expose your local server to the internet so Slack can send events:
```bash
ngrok http 3000
```
Update your Slack App's **Event Subscriptions** and **Slash Commands** URLs with your new ngrok address (e.g., `https://<your-ngrok-url>.ngrok-free.app/slack/events`).

---

## Testing

The project includes unit tests for business logic, mocking external dependencies (LLM, Jira, Slack).

```bash
# Run unit tests
npm run test

# Run tests with coverage
npm run test:cov
```

## CI/CD Pipeline

This repository uses GitHub Actions (`.github/workflows/ci.yml`). On every push to `main`, the pipeline automatically:
1. Provisions temporary PostgreSQL and Redis instances.
2. Generates the Prisma schema.
3. Runs the Oxlint linter.
4. Executes the Vitest test suite.
5. Builds the production NestJS bundle.
