import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface BetterBugsEnvironment {
  os?: string;
  browser?: string;
  windowSize?: string;
  networkSpeed?: string;
  userAgent?: string;
}

export interface BetterBugsDetails {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  reportedBy?: string;
  createdAt?: string;
  url?: string;
  environment?: BetterBugsEnvironment;
  reproSteps?: string[];
  tags?: string[];
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
}

export interface ConsoleLogEntry {
  level: string;
  message: string;
  stack?: string;
  timestamp?: string;
}

export interface NetworkRequestEntry {
  url: string;
  method: string;
  status: number;
  duration?: number;
  timestamp?: string;
  requestBody?: string;
  responseBody?: string;
}

export interface UserActionEntry {
  type: string;
  target?: string;
  value?: string;
  timestamp?: string;
}

export interface BetterBugsLogs {
  consoleLogs?: ConsoleLogEntry[];
  networkRequests?: NetworkRequestEntry[];
  userActions?: UserActionEntry[];
  rawText?: string;
}

export interface BetterBugsScreenshot {
  url?: string;
  mimeType?: string;
  description?: string;
  timestamp?: string;
  data?: string;
}

export interface InvestigationData {
  bugId: string;
  details?: BetterBugsDetails;
  logs?: BetterBugsLogs;
  screenshot?: BetterBugsScreenshot;
  error?: string;
}

export interface UpdateBugDetailsParams {
  bugId: string;
  workspaceId?: string;
  projectId?: string;
  title?: string;
  description?: string;
  status?: 'OPEN' | 'IN_PROGRESS' | 'CLOSED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  assignee?: string;
  comment?: string;
  mentions?: string[];
}

@Injectable()
export class BetterBugsService implements OnModuleDestroy {
  private readonly logger = new Logger(BetterBugsService.name);
  private readonly mcpUrl: string;
  private readonly mcpToken: string;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private isConnected = false;
  private currentConnectedUrl: string | null = null;
  private currentConnectedToken: string | null = null;

  constructor(private readonly configService: ConfigService) {
    this.mcpUrl =
      this.configService.get<string>('betterbugs.mcpUrl') ||
      process.env.BETTERBUGS_MCP_URL ||
      'http://localhost:3001/mcp';

    this.mcpToken =
      this.configService.get<string>('betterbugs.mcpToken') ||
      process.env.BETTERBUGS_MCP_TOKEN ||
      '';

    this.logger.log(`BetterBugsService initialized with default MCP URL: ${this.mcpUrl}`);
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Reads the current active MCP URL and token directly from .env / process.env dynamically.
   * This enables instant switching between local mock and live production without server restart.
   */
  private getLiveConfig(): { mcpUrl: string; mcpToken: string } {
    let url =
      this.configService.get<string>('betterbugs.mcpUrl') ||
      process.env.BETTERBUGS_MCP_URL ||
      'http://localhost:3001/mcp';
    let token =
      this.configService.get<string>('betterbugs.mcpToken') ||
      process.env.BETTERBUGS_MCP_TOKEN ||
      '';

    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          if (trimmed.startsWith('BETTERBUGS_MCP_URL=')) {
            url = trimmed.substring('BETTERBUGS_MCP_URL='.length).trim();
          }
          if (trimmed.startsWith('BETTERBUGS_MCP_TOKEN=')) {
            token = trimmed.substring('BETTERBUGS_MCP_TOKEN='.length).trim();
          }
        }
      }
    } catch {
      // ignore read error and use defaults
    }

    return { mcpUrl: url, mcpToken: token };
  }

  /**
   * Resolves the authentication token from config, environment, or the local OAuth cache (~/.mcp-auth).
   */
  private resolveToken(configuredToken: string, targetUrl: string): string {
    // If connecting to local mock server, do not send OAuth bearer tokens
    if (targetUrl.includes('localhost') || targetUrl.includes('127.0.0.1')) {
      return configuredToken;
    }

    // Check local OAuth cache (~/.mcp-auth) first for freshest active token
    try {
      const authDir = path.join(os.homedir(), '.mcp-auth', 'mcp-remote-v1');
      if (fs.existsSync(authDir)) {
        const files = fs.readdirSync(authDir);
        const tokenFile = files.find((f) => f.endsWith('_tokens.json'));
        if (tokenFile) {
          const content = JSON.parse(
            fs.readFileSync(path.join(authDir, tokenFile), 'utf8'),
          );
          if (content.access_token) {
            this.logger.log(
              'Loaded BetterBugs MCP access token from local OAuth cache (~/.mcp-auth)',
            );
            return content.access_token;
          }
        }
      }
    } catch (err) {
      this.logger.debug(`Could not read cached MCP token: ${err}`);
    }

    if (configuredToken) {
      return configuredToken;
    }

    return '';
  }

  /**
   * Ensure active connection to BetterBugs MCP server.
   * Automatically handles hot-switching if the target URL changes in .env.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${operationName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  }

  /**
   * Robust MCP tool call wrapper with automatic reconnect, token-refresh retry, and timeout protection.
   */
  async callTool(name: string, args: Record<string, any>): Promise<any> {
    try {
      const client = await this.ensureConnected();
      return await this.withTimeout(
        client.callTool({ name, arguments: args }),
        15000,
        `BetterBugs tool "${name}"`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('invalid_token') ||
        msg.includes('Invalid access token') ||
        msg.includes('401')
      ) {
        this.logger.warn(
          `BetterBugs token expired or rejected (${msg}), forcing reconnect with fresh token...`,
        );
        await this.disconnect();
        const client = await this.ensureConnected();
        return await this.withTimeout(
          client.callTool({ name, arguments: args }),
          15000,
          `BetterBugs tool "${name}" (retry)`,
        );
      }
      throw error;
    }
  }

  /**
   * Ensure active connection to BetterBugs MCP server.
   * Automatically handles hot-switching if the target URL or OAuth token changes.
   */
  private async ensureConnected(): Promise<Client> {
    const config = this.getLiveConfig();
    const token = this.resolveToken(config.mcpToken, config.mcpUrl);

    // If already connected to the same URL with the same token, reuse existing client
    if (
      this.client &&
      this.isConnected &&
      this.currentConnectedUrl === config.mcpUrl &&
      this.currentConnectedToken === token
    ) {
      return this.client;
    }

    // If credentials or URL changed, disconnect first to re-establish
    if (this.client) {
      this.logger.log(
        `MCP connection credentials or URL changed, reconnecting...`,
      );
      await this.disconnect();
    }

    this.logger.debug(`Connecting to BetterBugs MCP at ${config.mcpUrl}...`);

    this.client = new Client({
      name: 'betterbugs-slack-agent',
      version: '0.1.0',
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    this.transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
      requestInit: { headers },
    });

    try {
      await this.client.connect(this.transport);
      this.isConnected = true;
      this.currentConnectedUrl = config.mcpUrl;
      this.currentConnectedToken = token;
      this.logger.log(`Connected to BetterBugs MCP server at ${config.mcpUrl}`);
      return this.client;
    } catch (err) {
      this.isConnected = false;
      this.currentConnectedUrl = null;
      this.currentConnectedToken = null;
      this.logger.error(
        `Failed to connect to BetterBugs MCP at ${config.mcpUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        this.logger.warn(`Error closing MCP client: ${String(err)}`);
      }
      this.isConnected = false;
      this.currentConnectedUrl = null;
      this.currentConnectedToken = null;
      this.client = null;
      this.transport = null;
    }
  }

  /**
   * Helper to parse text content returned from MCP tools.
   * Handles direct JSON, JSON preceded by introductory text, and BetterBugs API error messages.
   */
  private parseToolResponse<T>(result: unknown): T | undefined {
    if (!result || typeof result !== 'object') return undefined;

    const res = result as { content?: Array<{ type: string; text?: string }> };
    if (res.content && Array.isArray(res.content) && res.content.length > 0) {
      const textItem = res.content.find((c) => c.type === 'text' && c.text);
      if (textItem && textItem.text) {
        const raw = textItem.text.trim();

        // Check if the response is an error message from BetterBugs API
        if (raw.startsWith('Error ') || raw.startsWith('Error:')) {
          this.logger.warn(`BetterBugs MCP returned error: ${raw}`);
          return undefined;
        }

        // 1. Try direct JSON parse
        try {
          return JSON.parse(raw) as T;
        } catch {
          // 2. Try extracting JSON object or array if preceded by preamble text
          const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
          if (jsonMatch) {
            try {
              return JSON.parse(jsonMatch[0]) as T;
            } catch {
              // Ignore parse error
            }
          }

          this.logger.debug(
            `Could not parse JSON from tool response: ${raw.slice(0, 100)}`,
          );
          return undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * Fetch bug details by bug_id.
   */
  async getBugDetails(bugId: string): Promise<BetterBugsDetails | undefined> {
    try {
      const result = await this.callTool('getBugDetails', { bug_id: bugId });
      const parsed = this.parseToolResponse<any>(result);
      if (!parsed) return undefined;

      // Handle live BetterBugs API payload format
      if (parsed.bug && typeof parsed.bug === 'object') {
        const live = parsed;
        const osStr = live.system_info?.os
          ? `${live.system_info.os.name || ''} ${live.system_info.os.version || ''}`.trim()
          : undefined;
        const browserStr = live.system_info?.browser
          ? `${live.system_info.browser.name || ''} ${live.system_info.browser.version || ''}`.trim()
          : undefined;

        return {
          id: live.bug.id || bugId,
          title: live.bug.title || 'Untitled Session',
          status: live.bug.status,
          priority: live.bug.priority,
          reportedBy: live.bug.reporter?.email || live.bug.reporter?.user_id,
          createdAt: live.bug.timeline?.created_at,
          url: live.page_info?.url || `https://app.betterbugs.io/session/${bugId}`,
          environment: {
            os: osStr,
            browser: browserStr,
            userAgent: live.system_info?.user_agent,
          },
          projectId: live.project?.id,
          projectName: live.project?.name,
          workspaceId: live.workspace?.id,
          workspaceName: live.workspace?.name,
        };
      }

      return parsed as BetterBugsDetails;
    } catch (error) {
      this.logger.error(
        `Failed to fetch getBugDetails for ${bugId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Fetch technical bug logs (console, network, clickstream) by bug_id.
   */
  async getBugLogs(bugId: string): Promise<BetterBugsLogs | undefined> {
    try {
      const result = await this.callTool('getBugLogs', { bug_id: bugId });

      // 1. Try parsing structured JSON (e.g. from mock server)
      const parsedJson = this.parseToolResponse<BetterBugsLogs>(result);
      if (
        parsedJson &&
        (parsedJson.consoleLogs || parsedJson.networkRequests || parsedJson.userActions)
      ) {
        return parsedJson;
      }

      // 2. Combine text content from all content items (live BetterBugs server returns human-readable text)
      const res = result as { content?: Array<{ type: string; text?: string }> };
      if (res?.content && Array.isArray(res.content) && res.content.length > 0) {
        const allText = res.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!.trim())
          .join('\n\n');

        if (allText) {
          return this.parseTextBugLogs(allText);
        }
      }

      return undefined;
    } catch (error) {
      this.logger.error(
        `Failed to fetch getBugLogs for ${bugId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private parseTextBugLogs(text: string): BetterBugsLogs {
    const consoleLogs: ConsoleLogEntry[] = [];
    const networkRequests: NetworkRequestEntry[] = [];
    const userActions: UserActionEntry[] = [];

    // Parse console errors
    const consoleSection = text.match(
      /CRITICAL CONSOLE ERRORS[\s\S]*?(?=Network Requests Analysis|$)/i,
    );
    if (consoleSection) {
      const errorBlocks = consoleSection[0].split(/\n\d+\.\s+/).slice(1);
      for (const block of errorBlocks) {
        const lines = block.trim().split('\n');
        const message = lines[0]?.trim();
        consoleLogs.push({
          level: 'error',
          message: message || 'Unknown error',
          stack: block.trim(),
        });
      }
    }

    // Parse failed network requests
    const networkSection = text.match(
      /FAILED NETWORK REQUESTS[\s\S]*?(?=SUCCESSFUL NETWORK REQUESTS|User Interaction Steps|$)/i,
    );
    if (networkSection) {
      const reqBlocks = networkSection[0].split(/\n\d+\.\s+Failed Request:\s*/).slice(1);
      for (const block of reqBlocks) {
        const lines = block.trim().split('\n');
        const url = lines[0]?.trim();
        const methodMatch = block.match(/Method:\s*([A-Z]+)/i);
        const statusMatch = block.match(/Status:\s*(\w+)/i);
        networkRequests.push({
          url: url || 'Unknown URL',
          method: methodMatch ? methodMatch[1] : 'GET',
          status:
            statusMatch && !isNaN(Number(statusMatch[1]))
              ? Number(statusMatch[1])
              : 500,
        });
      }
    }

    // Parse user interaction steps
    const stepsSection = text.match(/User Interaction Steps[\s\S]*?(?=Evidence File:|$)/i);
    if (stepsSection) {
      const stepBlocks = stepsSection[0].split(/\n\d+\.\s+Step:\s*/).slice(1);
      for (const block of stepBlocks) {
        const lines = block.trim().split('\n');
        const type = lines[0]?.trim();
        const dataMatch = block.match(/Data:\s*([^\n]+)/i);
        const urlMatch = block.match(/URL:\s*([^\n]+)/i);
        userActions.push({
          type: type || 'USER_STEP',
          target: dataMatch ? dataMatch[1].trim() : undefined,
          value: urlMatch ? urlMatch[1].trim() : undefined,
        });
      }
    }

    return {
      consoleLogs,
      networkRequests,
      userActions,
      rawText: text,
    };
  }

  /**
   * List bugs from BetterBugs workspace/project.
   */
  async listBugs(
    workspaceId?: string,
    limit: number = 10,
    projectId?: string,
  ): Promise<any[]> {
    try {
      let wsId = workspaceId;
      let prjId = projectId;

      if (!wsId || !prjId) {
        const defaultContext = await this.getDefaultContext();
        wsId = wsId || defaultContext.workspaceId;
        prjId = prjId || defaultContext.projectId;
      }

      const args: Record<string, any> = { limit };
      if (wsId) args.workspace_id = wsId;
      if (prjId) args.project_id = prjId;

      const result = await this.callTool('listBugs', args);
      const parsed = this.parseToolResponse<any>(result);

      if (parsed?.bugs && Array.isArray(parsed.bugs)) {
        return parsed.bugs;
      }
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [];
    } catch (error) {
      this.logger.error(
        `Failed to listBugs: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Fetch screenshot image or metadata by bug_id.
   */
  async getScreenshot(bugId: string): Promise<BetterBugsScreenshot | undefined> {
    try {
      const result = await this.callTool('getScreenshot', { bug_id: bugId });
      return this.parseToolResponse<BetterBugsScreenshot>(result);
    } catch (error) {
      this.logger.error(
        `Failed to fetch getScreenshot for ${bugId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * High-level investigation method that gathers all available telemetry in parallel.
   */
  async fetchFullInvestigation(bugId: string): Promise<InvestigationData> {
    this.logger.log(`Beginning BetterBugs investigation for bug_id: ${bugId}`);

    try {
      const [details, logs, screenshot] = await Promise.all([
        this.getBugDetails(bugId),
        this.getBugLogs(bugId),
        this.getScreenshot(bugId),
      ]);

      if (!details && !logs) {
        return {
          bugId,
          error: `Could not retrieve details or telemetry for BetterBugs session "${bugId}". Please check if the link is valid and accessible.`,
        };
      }

      return {
        bugId,
        details,
        logs,
        screenshot,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Full investigation failed for ${bugId}: ${msg}`);
      return {
        bugId,
        error: `Investigation failed: ${msg}`,
      };
    }
  }

  private cachedContext: { workspaceId?: string; projectId?: string } | null = null;

  async getDefaultContext(): Promise<{ workspaceId?: string; projectId?: string }> {
    if (this.cachedContext) return this.cachedContext;

    try {
      const wsResult = await this.callTool('listWorkspaces', {});
      const parsed = this.parseToolResponse<any>(wsResult);
      if (parsed?.workspaces?.[0]) {
        const ws = parsed.workspaces[0];
        this.cachedContext = {
          workspaceId: ws.id,
          projectId: ws.projects?.[0]?.id,
        };
        return this.cachedContext;
      }
    } catch (err) {
      this.logger.warn(`Could not load default workspace context: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  }

  /**
   * Update bug attributes such as assignee, status, priority, comment, or mentions.
   */
  async updateBugDetails(params: UpdateBugDetailsParams): Promise<any> {
    try {
      const client = await this.ensureConnected();

      let workspaceId = params.workspaceId;
      let projectId = params.projectId;

      // On live BetterBugs, workspace_id and project_id are required
      if (!workspaceId || !projectId) {
        try {
          const bugInfo = await this.getBugDetails(params.bugId);
          if (bugInfo?.workspaceId) workspaceId = workspaceId || bugInfo.workspaceId;
          if (bugInfo?.projectId) projectId = projectId || bugInfo.projectId;
        } catch {
          // ignore and fall back to default context
        }

        if (!workspaceId || !projectId) {
          const defaultContext = await this.getDefaultContext();
          workspaceId = workspaceId || defaultContext.workspaceId;
          projectId = projectId || defaultContext.projectId;
        }
      }

      const args: Record<string, any> = {
        bug_id: params.bugId,
      };

      if (workspaceId) args.workspace_id = workspaceId;
      if (projectId) args.project_id = projectId;
      if (params.assignee) args.assignee = params.assignee;
      if (params.status) args.bug_status = params.status;
      if (params.priority) args.priority = params.priority;
      if (params.title) args.title = params.title;
      if (params.description) args.description = params.description;
      if (params.comment) args.comment = params.comment;
      if (params.mentions && params.mentions.length > 0) args.mentions = params.mentions;

      this.logger.log(
        `Updating BetterBugs bug ${params.bugId} via MCP: ${JSON.stringify(args)}`,
      );

      const result = await this.callTool('updateBugDetails', args);
      const resText = (result as any)?.content?.[0]?.text;
      if (resText && typeof resText === 'string') {
        if (
          resText.includes('401 Unauthorized') ||
          resText.includes('not allowed to access this workspace')
        ) {
          this.logger.warn(
            `BetterBugs updateBugDetails permission notice: ${resText.trim()}`,
          );
          return { error: 'WORKSPACE_PERMISSION_DENIED', message: resText.trim() };
        }
      }

      return this.parseToolResponse(result) || result;
    } catch (error) {
      this.logger.error(
        `Failed to updateBugDetails for ${params.bugId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
