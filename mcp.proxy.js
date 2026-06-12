#!/usr/bin/env node

/**
 * MCP Proxy — wraps any existing MCP server with idle-mode support.
 *
 * The child MCP server starts immediately but its tools are hidden until
 * activate_domain or set_task_context is called. Once activated, all child
 * tools are exposed transparently.
 *
 * Usage in .mcp.json:
 *   {
 *     "command": "node",
 *     "args": ["path/to/shared-mcp-runtime/mcp.proxy.js",
 *              "--name=antigravity-gemini-mcp",
 *              "--child-cmd=node",
 *              "--child-arg=path/to/antigravity-gemini-mcp/index.js"]
 *   }
 *
 * Or for npx-based MCPs:
 *   {
 *     "command": "node",
 *     "args": ["path/to/shared-mcp-runtime/mcp.proxy.js",
 *              "--name=playwright",
 *              "--child-cmd=npx.cmd",
 *              "--child-arg=-y",
 *              "--child-arg=@playwright/mcp@latest"]
 *   }
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createToolExposureRuntime } from "./index.js";

// Parse CLI args. Support both "--key value" and "--key=value" because
// Claude/Codex MCP configs often use the latter for readability.
const args = process.argv.slice(2);
const config = { childCmd: "node", childArgs: [] };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
  const value = inlineValue ?? args[i + 1];

  if (key === "--name") {
    config.name = value;
    if (inlineValue === undefined) i++;
  } else if (key === "--child-cmd") {
    config.childCmd = value;
    if (inlineValue === undefined) i++;
  } else if (key === "--child-arg") {
    config.childArgs.push(value);
    if (inlineValue === undefined) i++;
  } else {
    config.childArgs.push(arg);
  }
}

if (!config.name || config.childArgs.length === 0) {
  console.error("Usage: mcp.proxy.js --name=<server-name> --child-cmd=<cmd> --child-arg=<arg>...");
  process.exit(1);
}

// --- Spawn child MCP ---
let childTools = [];
let childReady = false;
let childInitPromise = null;
let childToolsPromise = null;
let requestId = 0;
const pending = new Map();

const child = spawn(config.childCmd, config.childArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
  windowsHide: true,
  shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(config.childCmd),
});

let childBuf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  childBuf += chunk;
  const lines = childBuf.split("\n");
  childBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch { /* ignore */ }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  process.stderr.write(`[proxy:${config.name}] ${chunk}`);
});

child.on("error", (err) => {
  process.stderr.write(`[proxy:${config.name}] child error: ${err.message}\n`);
});

child.on("exit", (code, signal) => {
  const message = `Child MCP exited: code=${code ?? "null"} signal=${signal ?? "null"}`;
  process.stderr.write(`[proxy:${config.name}] ${message}\n`);
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(new Error(message));
  }
  pending.clear();
});

function sendToChild(req) {
  child.stdin.write(JSON.stringify(req) + "\n");
}

function notifyChild(method, params = {}) {
  sendToChild({ jsonrpc: "2.0", method, params });
}

async function callChild(method, params) {
  const id = ++requestId;
  const req = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Child MCP timeout: ${method}`));
      }
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject,
      timeout,
    });
    sendToChild(req);
  });
}

async function ensureChildReady() {
  if (childReady) return;
  if (childInitPromise) return childInitPromise;

  childInitPromise = (async () => {
    const initResp = await callChild("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "shared-mcp-proxy", version: "0.3.0" },
    });

    // Some MCP servers return warning-like init errors but still answer
    // tools/list. Any response means the child process is alive and speaking
    // JSON-RPC, so do not permanently hide it behind a strict init check.
    childReady = true;
    notifyChild("notifications/initialized");

    if (initResp.error) {
      process.stderr.write(
        `[proxy:${config.name}] child init returned error but is alive: ` +
        `${initResp.error.message?.substring(0, 120)}\n`
      );
    }
  })().finally(() => {
    childInitPromise = null;
  });

  return childInitPromise;
}

async function refreshChildTools() {
  if (childToolsPromise) return childToolsPromise;

  childToolsPromise = (async () => {
    await ensureChildReady();
    const tlResp = await callChild("tools/list", {});
    if (tlResp.error) {
      throw new Error(tlResp.error.message || "Child tools/list failed");
    }
    childTools = tlResp?.result?.tools || [];
    return childTools;
  })().finally(() => {
    childToolsPromise = null;
  });

  return childToolsPromise;
}

function prewarmChildTools() {
  refreshChildTools().catch((err) => {
    process.stderr.write(`[proxy:${config.name}] child prewarm failed: ${err.message}\n`);
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toMcpResult(result) {
  return {
    content: result.content || [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result.structuredContent || undefined,
  };
}

// --- Stage-aware exposure controller ---
const exposure = createToolExposureRuntime({
  name: config.name,
  enableTaskContext: true,
  verbose: false,
  toolProvider: async (ctx) => {
    const tools = [];
    const handlers = [];

    try {
      await ensureChildReady();
    } catch (err) {
      // Child might not be ready yet; return empty tools, will retry.
      process.stderr.write(`[proxy:${config.name}] child init failed: ${err.message}\n`);
      return { tools: [], handlers: [] };
    }

    // Only expose child tools after task context or domain activation
    if (!ctx.task.hasTask && ctx.domains.size === 0) {
      if (childTools.length === 0) prewarmChildTools();
      return { tools: [], handlers: [] };
    }

    // Fetch child tools once, then reuse the cached schema. This keeps
    // activation fast after the idle-time prewarm has completed.
    if (childTools.length === 0) {
      try {
        await refreshChildTools();
      } catch (err) {
        process.stderr.write(`[proxy:${config.name}] child tools/list failed: ${err.message}\n`);
      }
    }

    for (const t of childTools) {
      tools.push(t);
      handlers.push({
        name: t.name,
        handler: async (args) => {
          const resp = await callChild("tools/call", { name: t.name, arguments: args });
          if (resp.error) {
            throw new Error(resp.error.message || `Child tool ${t.name} failed`);
          }
          return {
            content: resp.result?.content || [{ type: "text", text: JSON.stringify(resp.result) }],
            structuredContent: resp.result?.structuredContent || undefined,
          };
        },
      });
    }

    return { tools, handlers };
  },
  onToolsChanged: async () => {
    send({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    });
  },
});

async function handle(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    await exposure.refreshTools();
    prewarmChildTools();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: config.name, version: "proxy-0.2.0" },
      },
    };
  }

  if (method === "tools/list") {
    await exposure.refreshTools();
    return { jsonrpc: "2.0", id, result: { tools: exposure.getTools() } };
  }

  if (method === "tools/call") {
    const result = await exposure.callTool(params?.name, params?.arguments || {});
    return {
      jsonrpc: "2.0",
      id,
      result: toMcpResult(result),
    };
  }

  if (id === undefined) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error.message}` },
    });
    return;
  }

  try {
    const response = await handle(request);
    if (response) send(response);
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: request.id ?? null,
      error: { code: -32000, message: error.message },
    });
  }
});
