# AI-Powered Slack Bot

An enterprise-grade Slack assistant built with **NestJS, TypeScript, PostgreSQL, Prisma, Redis, BullMQ, and LLM tool calling**.

This bot integrates directly with the Slack Events API to provide autonomous bug Root Cause Analysis (RCA) via BetterBugs MCP, conversational thread triage, Jira ticket creation, slash commands, and delayed workflow automation.

---

## System Architecture

The backend uses a modular architecture, separating Slack communication, AI processing, BetterBugs MCP telemetry ingestion, Jira ticketing, and persistence into isolated NestJS modules.

- **API Layer**: NestJS REST endpoints and Slack webhook receivers with signature verification (`SlackSignatureGuard`) and rate limiting (`RateLimitGuard`).
- **BetterBugs Integration**: Connects via Model Context Protocol (MCP) to fetch bug details, console logs, failed HTTP 4xx/5xx requests, and user click actions.
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
   `Slack Session URL` -> `Webhook Guard` -> `Fast ACK (<3s)` -> `BetterBugs MCP (Telemetry Fetch)` -> `Security Sanitizer (PII/Token Scrubbing)` -> `RCA Engine` -> `Interactive Block Kit Card`
2. **Conversational Triage & Jira Tool Calling:**
   `Slack Thread Mention` -> `AI Intent & Tool Call Detection` -> `Jira REST API / BetterBugs Update` -> `Save Ticket to PostgreSQL` -> `Private Assignee Slack DM`
3. **Background Job Automation (Reminders):**
   `Schedule Request` -> `BullMQ Delayed Queue (Redis)` -> `Delayed Execution` -> `Slack Thread Notification`

---

## Key Features

### 1. Autonomous Bug RCA & BetterBugs Ingestion
- Detects BetterBugs session and share URLs (`https://app.betterbugs.io/sessions/...` or `/share/...`) posted in any channel or thread.
- Fetches session metadata, console errors, network failures, and click traces via BetterBugs MCP.
- Redacts authorization tokens, bearer headers, passwords, and sensitive PII through `TelemetrySanitizer` before model submission.
- Generates structured Root Cause Analysis (RCA) and renders an interactive Slack Block Kit card.
- RCA card buttons include:
  - **Create Jira Ticket**: Creates a Jira ticket pre-populated with bug details and links back to the Slack thread.
  - **Change Status**: Updates the bug status and priority in BetterBugs.
  - **Assign to Me**: Assigns the bug to the clicking user and sends a direct Slack confirmation DM.
  - **Set Reminder**: Schedules a BullMQ reminder for follow-up.

### 2. Conversational Triage & Thread Memory
- Maintains continuous thread context by retrieving recent message history from PostgreSQL.
- Supports natural language commands in threads and direct messages:
  - `"Assign this bug to @Alex"`
  - `"Add comment: Verified fix on staging"`
  - `"Create a Jira ticket for this"`
  - `"Update status to IN_PROGRESS and priority to HIGH"`
  - `"Remind me to check this in 10 minutes"`

### 3. Slash Commands
- `/ask <question>`: Query the AI directly with conversational context.
- `/help`: Display a quick-reference guide of available commands and conversational syntax.
- `/jira <summary>`: Create a Jira task directly from thread or bug context.
- `/assign <@user>`: Assign the current bug report to a teammate.
- `/comment <note>`: Add a note or triage comment to the BetterBugs report.
- `/summarize`: Generates a concise summary of the current thread.
- `/action-items`: Extracts actionable tasks from the discussion.

### 4. Jira Integration (Tool Calling)
- Detects bug reports or task requests via LLM tool calling.
- Validates requests and creates live tickets via Jira REST API using Atlassian Document Format (ADF).
- Saves ticket mapping to PostgreSQL and posts direct links to Slack.

### 5. Reliability & Security
- **Idempotency**: Prevents processing duplicate Slack event retries using atomic Redis claims (`SET NX`).
- **Signature Verification**: Verifies Slack signing secret on all incoming webhook requests.
- **Rate Limiting**: Throttles abusive requests per user/IP using Redis sliding window.
- **Multi-Workspace**: Dynamically partitions data and channels using Slack `team_id`.

---

## Setup Instructions

### 1. Prerequisites
- Node.js (v24+)
- Docker & Docker Compose
- ngrok (for Slack event tunneling during local development)

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

# AI (OpenRouter)
OPENROUTER_API_KEY="your-llm-api-key"
AI_MODEL="openai/gpt-4o-mini"
AI_MAX_CONTEXT_MESSAGES="20"

# Jira Integration (Optional)
JIRA_BASE_URL="https://your-domain.atlassian.net"
JIRA_EMAIL="your-email@example.com"
JIRA_API_TOKEN="your-jira-token"
JIRA_PROJECT_KEY="PROJ"

# BetterBugs MCP Integration
BETTERBUGS_MCP_URL="http://localhost:3001/mcp"
BETTERBUGS_MCP_TOKEN=""

# Rate Limiting
RATE_LIMIT_TTL="60"
RATE_LIMIT_MAX="20"
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

### 5. Start BetterBugs MCP Mock Server (Local Development)
If you do not have access to a remote BetterBugs MCP server, start the included local MCP mock server in a separate terminal:
```bash
npm run mock:mcp
```
This runs an MCP Streamable HTTP server on `http://localhost:3001/mcp` simulating all 7 BetterBugs MCP tools (`getBugDetails`, `getBugLogs`, `getScreenshot`, `updateBugDetails`, `listBugs`, `recordingLink`, `listProjects`).

### 6. Start the Application
Install dependencies and run the NestJS server:
```bash
npm install
npm run start:dev
```

### 7. Connect Slack (ngrok)
Expose your local server to the internet so Slack can send events:
```bash
ngrok http 3000
```
Update your Slack App configuration:
- **Event Subscriptions URL**: `https://<your-ngrok-url>.ngrok-free.app/slack/events`
- **Interactivity & Shortcuts Request URL**: `https://<your-ngrok-url>.ngrok-free.app/slack/actions`
- **Slash Commands Request URLs**: `https://<your-ngrok-url>.ngrok-free.app/slack/commands`

---

## Testing & Quality Verification

```bash
# Run unit tests
npm run test

# Run tests with coverage
npm run test:cov

# Run end-to-end tests
npm run test:e2e

# Run linter
npm run lint

# Build production bundle
npm run build
```

---

## CI/CD Pipeline

This repository uses GitHub Actions (`.github/workflows/ci.yml`). On every push to `main` or pull request, the pipeline automatically:
1. Provisions temporary PostgreSQL and Redis instances.
2. Generates the Prisma schema and syncs the database.
3. Runs the Oxlint type-aware linter.
4. Executes the full Vitest unit test suite.
5. Builds the production NestJS bundle.
