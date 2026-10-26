/**
 * BetterBugs MCP Mock Server
 *
 * Simulates the BetterBugs MCP server locally with all 7 tools.
 * Uses the official MCP SDK's StreamableHTTPServerTransport with proper session handling.
 *
 * Usage:
 *   npx tsx scripts/mcp-mock-server.ts
 *   Then set BETTERBUGS_MCP_URL=http://localhost:3001/mcp in your .env
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const PORT = 3001;

// ─── Mock Data ──────────────────────────────────────────────────────────────

const MOCK_BUG_DETAILS = {
  id: 'bug-abc123',
  title: 'Checkout crashes when shipping address is missing zip code',
  status: 'open',
  priority: 'high',
  reportedBy: 'qa-engineer@company.com',
  createdAt: '2026-10-12T09:30:00Z',
  url: 'https://app.betterbugs.io/bugs/bug-abc123',
  environment: {
    os: 'macOS 15.1',
    browser: 'Chrome 130.0.6723.58',
    windowSize: '1440x900',
    networkSpeed: '4g',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  },
  reproSteps: [
    'Navigate to /checkout',
    'Fill in all fields except ZIP code in shipping address',
    'Click "Complete Purchase" button',
    'Page crashes with white screen',
  ],
  tags: ['checkout', 'crash', 'shipping'],
  projectId: 'proj-xyz789',
  projectName: 'E-Commerce Frontend',
};

const MOCK_BUG_LOGS = {
  consoleLogs: [
    {
      level: 'error',
      message: "TypeError: Cannot read properties of undefined (reading 'zip')",
      stack: `TypeError: Cannot read properties of undefined (reading 'zip')
    at CheckoutForm.validateAddress (CheckoutForm.tsx:142:38)
    at CheckoutForm.handleSubmit (CheckoutForm.tsx:89:14)
    at HTMLFormElement.callCallback (react-dom.production.min.js:3:31)`,
      timestamp: '2026-10-12T09:28:45.123Z',
    },
    {
      level: 'warn',
      message: 'ShippingAddress component received undefined for prop "address.zip"',
      timestamp: '2026-10-12T09:28:44.800Z',
    },
    {
      level: 'error',
      message: 'Unhandled Promise Rejection: Failed to submit order',
      timestamp: '2026-10-12T09:28:45.200Z',
    },
  ],
  networkRequests: [
    {
      url: 'https://api.example.com/v1/cart',
      method: 'GET',
      status: 200,
      duration: 145,
      timestamp: '2026-10-12T09:28:30.500Z',
    },
    {
      url: 'https://api.example.com/v1/orders',
      method: 'POST',
      status: 400,
      duration: 89,
      timestamp: '2026-10-12T09:28:45.000Z',
      requestBody: '{"items":[...],"shippingAddress":{"street":"123 Main St","city":"San Francisco","state":"CA"}}',
      responseBody: '{"error":"validation_error","message":"zip is required in shippingAddress","field":"shippingAddress.zip"}',
    },
    {
      url: 'https://cdn.example.com/assets/main.css',
      method: 'GET',
      status: 200,
      duration: 12,
      timestamp: '2026-10-12T09:28:29.000Z',
    },
  ],
  userActions: [
    { type: 'navigation', target: '/checkout', timestamp: '2026-10-12T09:28:30.000Z' },
    { type: 'input', target: 'input[name="street"]', value: '123 Main St', timestamp: '2026-10-12T09:28:38.000Z' },
    { type: 'click', target: 'button.complete-purchase', timestamp: '2026-10-12T09:28:44.500Z' },
  ],
};

const MOCK_SCREENSHOT = {
  url: 'https://app.betterbugs.io/screenshots/bug-abc123/crash-state.png',
  mimeType: 'image/png',
  description: 'Screenshot captured at the moment of the checkout crash.',
  timestamp: '2026-10-12T09:28:45.300Z',
};

// ─── MCP Server Factory ─────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'betterbugs-mock',
    version: '0.1.0',
  });

  mcpServer.tool('getUserDetails', 'Get current user details', {}, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ id: 'user-001', email: 'dev@company.com', name: 'Test Developer', role: 'admin' }) }],
  }));

  mcpServer.tool('listWorkspaces', 'List workspaces', {}, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify([{ id: 'ws-001', name: 'Acme Corp', plan: 'pro' }]) }],
  }));

  mcpServer.tool('listProjects', 'List projects in workspace', { workspace_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify([{ id: 'proj-xyz789', name: 'E-Commerce Frontend', bugCount: 42 }]) }],
  }));

  mcpServer.tool('listBugs', 'List bugs in project', { workspace_id: z.string(), project_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify([{ id: 'bug-abc123', title: MOCK_BUG_DETAILS.title, status: 'open' }]) }],
  }));

  mcpServer.tool('getBugDetails', 'Get bug details by bug_id or session URL', { bug_id: z.string(), workspace_id: z.string().optional(), project_id: z.string().optional() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(MOCK_BUG_DETAILS) }],
  }));

  mcpServer.tool('getBugLogs', 'Get bug logs by bug_id', { bug_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(MOCK_BUG_LOGS) }],
  }));

  mcpServer.tool('getScreenshot', 'Get screenshot metadata by bug_id', { bug_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify(MOCK_SCREENSHOT) }],
  }));

  mcpServer.tool('getVideoAnalysis', 'Get AI video analysis for screen recording', { workspace_id: z.string(), bug_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ summary: 'User encountered crash on checkout submission.', hasSpeech: false }) }],
  }));

  mcpServer.tool('getTranscription', 'Get audio transcription of screen recording', { workspace_id: z.string(), bug_id: z.string() }, async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ hasSpeech: false, transcript: '' }) }],
  }));

  mcpServer.tool(
    'updateBugDetails',
    'Update one or more attributes of a bug',
    {
      bug_id: z.string(),
      workspace_id: z.string().optional(),
      project_id: z.string().optional(),
      assignee: z.string().optional(),
      comment: z.string().optional(),
      mentions: z.array(z.string()).optional(),
      bug_status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    },
    async (args) => {
      const updatedFields: string[] = [];
      if (args.assignee) {
        MOCK_BUG_DETAILS.reportedBy = args.assignee;
        updatedFields.push(`assignee: ${args.assignee}`);
      }
      if (args.bug_status) {
        MOCK_BUG_DETAILS.status = args.bug_status.toLowerCase();
        updatedFields.push(`status: ${args.bug_status}`);
      }
      if (args.priority) {
        MOCK_BUG_DETAILS.priority = args.priority.toLowerCase();
        updatedFields.push(`priority: ${args.priority}`);
      }
      if (args.title) {
        MOCK_BUG_DETAILS.title = args.title;
        updatedFields.push(`title: ${args.title}`);
      }
      if (args.comment) {
        updatedFields.push(`comment: "${args.comment}"`);
      }
      if (args.mentions && args.mentions.length > 0) {
        updatedFields.push(`mentions: ${args.mentions.join(', ')}`);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              message: `Bug ${args.bug_id} updated successfully.`,
              updated: updatedFields,
            }),
          },
        ],
      };
    },
  );

  mcpServer.tool(
    'jira',
    'Unified Jira integration tool for BetterBugs',
    {
      action: z.enum([
        'list_sites',
        'list_projects',
        'list_issue_types',
        'get_field_metadata',
        'list_assignees',
        'list_labels',
        'list_boards',
        'list_sprints',
        'search_issues',
        'send_bug',
      ]),
      workspace_id: z.string(),
      site_id: z.string().optional(),
      project_id: z.string().optional(),
      issue_type_id: z.string().optional(),
      bug_id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    },
    async (args) => {
      if (args.action === 'list_sites') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify([{ id: 'site-jira-01', name: 'company.atlassian.net' }]),
            },
          ],
        };
      }
      if (args.action === 'send_bug') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                key: 'PROJ-101',
                url: 'https://company.atlassian.net/browse/PROJ-101',
                message: `Created Jira task PROJ-101 for bug ${args.bug_id}`,
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ success: true, action: args.action }),
          },
        ],
      };
    },
  );

  return mcpServer;
}

// ─── Express App with Streamable HTTP Transport ─────────────────────────────

const app = express();
app.use(express.json());

// Store session objects by session ID
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

// POST /mcp: JSON-RPC over Streamable HTTP
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && sessions.has(sessionId)) {
      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId) {
      // New initialization request
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
      }
      return;
    }

    // Session ID was passed but not recognized
    res.status(404).json({ error: 'Session not found' });
  } catch (error) {
    console.error('MCP POST handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// GET /mcp: SSE stream if session exists, else 405 Method Not Allowed
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }

  // 405 informs StreamableHTTPClientTransport that initial GET SSE is not supported
  res.status(405).setHeader('Allow', 'POST').send('Method Not Allowed: Send POST to initialize');
});

// DELETE /mcp: Session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
    return;
  }
  res.status(404).json({ error: 'Session not found' });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    tools: 7,
    activeSessions: sessions.size,
    availableTools: [
      'getUserDetails',
      'listWorkspaces',
      'listProjects',
      'listBugs',
      'getBugDetails',
      'getBugLogs',
      'getScreenshot',
    ],
  });
});

app.listen(PORT, () => {
  console.log(`\n[BetterBugs MCP Mock Server] running on http://localhost:${PORT}/mcp`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`\n   Available tools: getUserDetails, listWorkspaces, listProjects, listBugs, getBugDetails, getBugLogs, getScreenshot`);
  console.log(`\n   Set BETTERBUGS_MCP_URL=http://localhost:${PORT}/mcp in .env to use this mock\n`);
});
