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
 *     "args": ["D:\\Codex\\New\\shared-mcp-runtime\\mcp.proxy.js",
 *              "--name=antigravity-gemini-mcp",
 *              "--child-cmd=D:\\nodejs\\node.exe",
 *              "--child-arg=D:\\Codex\\New\\antigravity-gemini-mcp\\index.js"]
 *   }
 *
 * Or for npx-based MCPs:
 *   {
 *     "command": "node",
 *     "args": ["D:\\Codex\\New\\shared-mcp-runtime\\mcp.proxy.js",
 *              "--name=playwright",
 *              "--child-cmd=npx.cmd",
 *              "--child-arg=-y",
 *              "--child-arg=@playwright/mcp@latest"]
 *   }
 */

import { spawn } from "node:child_process";
import { createMcpServer } from "./index.js";

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
let requestId = 0;
const pending = new Map();

const child = spawn(config.childCmd, config.childArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
  windowsHide: true,
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

// --- Server ---
const server = createMcpServer({
  name: config.name,
  version: "proxy-0.1.0",
  listChanged: true,
  enableTaskContext: true,
  verbose: false,

  toolProvider: async (ctx) => {
    const tools = [];
    const handlers = [];

    if (!childReady) {
      try {
        const initResp = await callChild("initialize", { protocolVersion: "2025-06-18" });
        if (initResp.error) throw new Error(initResp.error.message);
        childReady = true;
      } catch (err) {
        // Child might not be ready yet; return empty tools, will retry
        return { tools: [], handlers: [] };
      }
    }

    // Only expose child tools after task context or domain activation
    if (!ctx.task.hasTask && ctx.domains.size === 0) {
      return { tools: [], handlers: [] };
    }

    // Fetch child tools
    try {
      const tlResp = await callChild("tools/list", {});
      childTools = tlResp?.result?.tools || [];
    } catch {
      // Keep previous child tools
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
});

server.run();
