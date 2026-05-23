/**
 * McpManager — manages connections to MCP (Model Context Protocol) servers
 * and bridges their tools into the agent's Tool interface.
 *
 * Config is read from mcp.config.json at process.cwd() (edu-platform/).
 * The singleton is stored on `global` to survive Next.js hot-reload cycles.
 *
 * Supported transports:
 *   "stdio"  — local process spawned via command + args (e.g. npx)
 *   "sse"    — legacy SSE endpoint (older MCP servers)
 *   "http"   — modern StreamableHTTP endpoint (MCP spec 2025+)
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, JSONSchema } from "./types";
import { logger } from "@/lib/logger";

const log = logger.child({ component: "mcp-manager" });

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type McpTransport = "stdio" | "sse" | "http";

export type McpServerConfig = {
  /** Unique identifier used for tool name prefixing: mcp_{id}_{toolName} */
  id: string;
  /** Human-readable label shown in tool descriptions */
  label: string;
  enabled: boolean;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  /** Extra env vars merged on top of a safe subset of process.env */
  env?: Record<string, string>;
  cwd?: string;
  // sse / http
  url?: string;
  /** HTTP headers (e.g. Authorization) */
  headers?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConnectedServer = {
  client: Client;
  tools: Tool[];
};

// ---------------------------------------------------------------------------
// McpManager singleton
// ---------------------------------------------------------------------------

const GLOBAL_KEY = "__edu_mcp_manager__";
const globalStore = global as typeof global & { [GLOBAL_KEY]?: McpManager };

export class McpManager {
  private _servers = new Map<string, ConnectedServer>();
  private _initPromise: Promise<void> | null = null;

  // ---- Singleton -----------------------------------------------------------

  static getInstance(): McpManager {
    if (!globalStore[GLOBAL_KEY]) {
      globalStore[GLOBAL_KEY] = new McpManager();
    }
    return globalStore[GLOBAL_KEY]!;
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Returns all tools from all enabled, successfully-connected MCP servers.
   * Lazily initialises connections on first call; subsequent calls are fast.
   */
  async getTools(): Promise<Tool[]> {
    await this._ensureInit();
    const tools: Tool[] = [];
    for (const server of this._servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  /**
   * Closes all active connections, clears state, and resets the init flag
   * so the next getTools() call re-reads mcp.config.json and reconnects.
   */
  async reset(): Promise<void> {
    // Cancel any in-flight init
    this._initPromise = null;
    for (const [id, server] of this._servers) {
      try {
        await server.client.close();
      } catch (err) {
        log.warn({ err, serverId: id }, "McpManager: error closing client");
      }
    }
    this._servers.clear();
  }

  // ---- Test a single server config (used by /admin/mcp/test) --------------

  async testServer(cfg: McpServerConfig): Promise<{ tools: string[] }> {
    const client = this._createClient();
    const transport = this._createTransport(cfg);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return { tools: tools.map((t) => t.name) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  // ---- Private helpers -----------------------------------------------------

  private async _ensureInit(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this._init();
    }
    await this._initPromise;
  }

  private async _init(): Promise<void> {
    const configs = readConfig();
    await Promise.allSettled(
      configs
        .filter((c) => c.enabled)
        .map((cfg) =>
          this._connect(cfg).catch((err) => {
            log.warn({ err, serverId: cfg.id }, "McpManager: failed to connect to server");
          }),
        ),
    );
  }

  private async _connect(cfg: McpServerConfig): Promise<void> {
    const client = this._createClient();
    const transport = this._createTransport(cfg);

    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();

    // Bridge MCP tool definitions → our Tool interface
    const bridged: Tool[] = mcpTools.map((mcpTool) => {
      const toolName = `mcp_${cfg.id}_${mcpTool.name}`;
      // MCP tool names must fit within 64-char model limits; warn if truncated
      if (toolName.length > 64) {
        log.warn({ toolName }, "McpManager: tool name exceeds 64 chars, LLM may reject it");
      }
      return {
        name: toolName,
        description: `[${cfg.label}] ${mcpTool.description ?? ""}`.slice(0, 512),
        parameters: (mcpTool.inputSchema as JSONSchema) ?? {
          type: "object",
          properties: {},
        },
        category: "external" as const,
        execute: async (args: Record<string, unknown>) => {
          try {
            const result = await client.callTool({ name: mcpTool.name, arguments: args });
            // Extract text content from MCP result
            const parts = (result.content ?? []) as Array<{ type: string; text?: string }>;
            const text = parts
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("\n");
            if (result.isError) {
              return JSON.stringify({ error: text || "MCP tool returned an error" });
            }
            return text || JSON.stringify(result.content);
          } catch (err) {
            return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    });

    this._servers.set(cfg.id, { client, tools: bridged });
    log.info({ serverId: cfg.id, toolCount: bridged.length }, "McpManager: connected");
  }

  private _createClient(): Client {
    return new Client(
      { name: "edu-agent", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  private _createTransport(cfg: McpServerConfig) {
    switch (cfg.transport) {
      case "stdio": {
        if (!cfg.command) throw new Error(`MCP server "${cfg.id}": stdio requires command`);
        return new StdioClientTransport({
          command: cfg.command,
          args: cfg.args ?? [],
          env: cfg.env ? { ...process.env, ...cfg.env } as Record<string, string> : undefined,
          cwd: cfg.cwd,
          stderr: "pipe",
        });
      }
      case "sse": {
        if (!cfg.url) throw new Error(`MCP server "${cfg.id}": sse requires url`);
        return new SSEClientTransport(new URL(cfg.url), {
          eventSourceInit: cfg.headers
            ? { fetch: (url, init) => fetch(url, { ...init, headers: { ...cfg.headers, ...(init?.headers ?? {}) } }) }
            : undefined,
        });
      }
      case "http": {
        if (!cfg.url) throw new Error(`MCP server "${cfg.id}": http requires url`);
        return new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      }
      default:
        throw new Error(`MCP server "${(cfg as McpServerConfig).id}": unknown transport`);
    }
  }
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(process.cwd(), "mcp.config.json");

export function readConfig(): McpServerConfig[] {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as {
      servers?: McpServerConfig[];
    };
    return Array.isArray(parsed.servers) ? parsed.servers : [];
  } catch {
    return [];
  }
}

export function writeConfig(servers: McpServerConfig[]): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ servers }, null, 2), "utf-8");
}
