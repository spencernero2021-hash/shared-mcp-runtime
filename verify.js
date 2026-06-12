#!/usr/bin/env node

/**
 * Direct module verification for stage-aware tool exposure.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createToolExposureRuntime, classifyError, suggestionFor } from "./index.js";

const PASS = [];
const FAIL = [];

function check(label, condition, detail = "") {
  if (condition) {
    PASS.push(label);
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    FAIL.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProxySmoke() {
  const dummy = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const tool = { name: 'dummy_tool', description: 'Dummy tool', inputSchema: { type: 'object', properties: {} } };
rl.on('line', line => {
  const req = JSON.parse(line);
  if (req.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ protocolVersion:'2025-06-18', capabilities:{ tools:{} }, serverInfo:{ name:'dummy', version:'0.1.0' } } }));
  } else if (req.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ tools:[tool] } }));
  } else if (req.method === 'tools/call') {
    console.log(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{ type:'text', text:'ok' }], structuredContent:{ ok:true } } }));
  }
});
`;
  const child = spawn(process.execPath, [
    "mcp.proxy.js",
    "--name=dummy-proxy",
    "--child-cmd=node",
    "--child-arg=-e",
    `--child-arg=${dummy}`,
  ], { cwd: new URL(".", import.meta.url), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let buffer = "";
  const messages = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });

  function send(id, method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  send(1, "initialize", { protocolVersion: "2025-06-18" });
  send(2, "tools/list");
  await sleep(300);
  send(3, "tools/call", { name: "activate_domain", arguments: { domain: "dummy" } });
  await sleep(300);
  send(4, "tools/list");
  await sleep(300);
  child.kill();

  const byId = Object.fromEntries(messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
  return {
    idle: byId[2]?.result?.tools?.map((tool) => tool.name) || [],
    active: byId[4]?.result?.tools?.map((tool) => tool.name) || [],
  };
}

async function runInstallerSmoke() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-mcp-runtime-"));
  const configPath = path.join(tempDir, ".mcp.json");
  const child = spawn(process.execPath, [
    "bin/install-proxy.js",
    "--config",
    configPath,
    "--preset",
    "playwright",
    "--no-backup",
  ], { cwd: new URL(".", import.meta.url), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0) return { ok: false, error: `installer exited ${exitCode}` };

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const entry = config.mcpServers?.playwright;
  return {
    ok: !!entry,
    command: entry?.command,
    args: entry?.args || [],
  };
}

async function main() {
  console.log("=== Shared MCP Runtime — Tool Exposure Verification ===\n");

  // ====== 1. Error classification ======
  console.log("1. Error classification");
  check("timeout", classifyError(new Error("Connection timed out")) === "timeout");
  check("auth", classifyError(new Error("401 Unauthorized")) === "auth");
  check("network", classifyError(new Error("ECONNREFUSED")) === "network");
  check("validation", classifyError(new Error("invalid input")) === "validation");
  check("rate_limit", classifyError(new Error("429 Too Many Requests")) === "rate_limit");
  check("unknown", classifyError(new Error("xyzzy")) === "unknown");
  check("suggestions exist", suggestionFor("timeout").length > 0 && suggestionFor("unknown").length > 0);

  // ====== 2. Server creation ======
  console.log("\n2. Server creation");
  const runtime = createToolExposureRuntime({
    name: "verify-test",
    enableTaskContext: false,
    verbose: false,
    toolProvider: async (ctx) => ({
      tools: [{ name: "ping", description: "p", inputSchema: { type: "object", properties: {} } }],
      handlers: [{ name: "ping", handler: async () => ({ content: [{ type: "text", text: "pong" }] }) }],
    }),
  });

  check("runtime object created", !!runtime);
  check("has refreshTools method", typeof runtime.refreshTools === "function");
  check("has callTool method", typeof runtime.callTool === "function");
  check("has getTools method", typeof runtime.getTools === "function");
  check("has getDomains method", typeof runtime.getDomains === "function");

  // ====== 3. Tool loading via updateTools ======
  console.log("\n3. Tool loading (updateTools)");
  check("tools empty before load", runtime.getTools().length === 0);
  await runtime.refreshTools();
  const tools = runtime.getTools();
  check("tools loaded after updateTools", tools.length === 1);
  check("ping tool present", tools[0]?.name === "ping", JSON.stringify(tools));
  check("ping schema preserved", tools[0]?.inputSchema?.type === "object");

  // ====== 4. Domain expansion ======
  console.log("\n4. Domain expansion");
  const domainRuntime = createToolExposureRuntime({
    name: "domain-test",
    toolProvider: async (ctx) => {
      const tools = [
        { name: "base", description: "Always visible", inputSchema: { type: "object", properties: {} } },
      ];
      const handlers = [{
        name: "base",
        handler: async (args, hctx) => {
          await hctx.expandDomain("advanced");
          return { content: [{ type: "text", text: "done" }] };
        },
      }];

      if (ctx.hasDomain("advanced")) {
        tools.push({ name: "secret", description: "Only when expanded", inputSchema: { type: "object", properties: {} } });
        handlers.push({
          name: "secret",
          handler: async () => ({ content: [{ type: "text", text: "revealed" }] }),
        });
      }

      return { tools, handlers };
    },
  });

  await domainRuntime.refreshTools();
  const d1 = domainRuntime.getTools().map((t) => t.name);
  check("initial: base plus control tools", d1.includes("base") && d1.includes("activate_domain"), `got: ${d1}`);
  check("initial domains empty", domainRuntime.getDomains().size === 0);

  await domainRuntime.callTool("base", {});
  const d2 = domainRuntime.getTools().map((t) => t.name);
  check("after expansion: secret visible", d2.includes("secret"), `got: ${d2}`);

  // ====== 5. Multiple domains ======
  console.log("\n5. Multiple domain isolation");
  const multiRuntime = createToolExposureRuntime({
    name: "multi-test",
    toolProvider: async (ctx) => {
      const tools = [
        { name: "common", description: "Always", inputSchema: { type: "object", properties: {} } },
      ];
      const handlers = [{
        name: "common",
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }];

      if (ctx.hasDomain("design")) {
        tools.push({ name: "render_pptx", description: "Design tool", inputSchema: { type: "object", properties: {} } });
        handlers.push({ name: "render_pptx", handler: async () => ({ content: [{ type: "text", text: "rendered" }] }) });
      }
      if (ctx.hasDomain("market")) {
        tools.push({ name: "get_prices", description: "Market tool", inputSchema: { type: "object", properties: {} } });
        handlers.push({ name: "get_prices", handler: async () => ({ content: [{ type: "text", text: "prices" }] }) });
      }

      return { tools, handlers };
    },
  });

  await multiRuntime.refreshTools();
  const m1 = multiRuntime.getTools().map((t) => t.name);
  check("multi: common plus control tools initially", m1.includes("common") && m1.includes("activate_domain"), `got: ${m1}`);
  await multiRuntime.activateDomain({ domain: "design" });
  const m2 = multiRuntime.getTools().map((t) => t.name);
  check("multi: design tools visible after activation", m2.includes("render_pptx") && !m2.includes("get_prices"), `got: ${m2}`);

  // ====== 6. Proxy smoke ======
  console.log("\n6. Proxy smoke");
  const proxy = await runProxySmoke();
  check("proxy idle exposes control tools only", proxy.idle.length === 2 && proxy.idle.includes("activate_domain") && proxy.idle.includes("set_task_context"), `got: ${proxy.idle}`);
  check("proxy active exposes child tool", proxy.active.includes("dummy_tool"), `got: ${proxy.active}`);
  check("proxy active exposes clear_task_context", proxy.active.includes("clear_task_context"), `got: ${proxy.active}`);

  // ====== 7. Installer smoke ======
  console.log("\n7. Installer smoke");
  const installer = await runInstallerSmoke();
  check("installer writes config entry", installer.ok, installer.error || "");
  check("installer uses node command", installer.command === "node", `got: ${installer.command}`);
  check("installer points at proxy", installer.args.some((arg) => String(arg).endsWith("mcp.proxy.js")), `got: ${installer.args}`);
  check("installer applies preset package", installer.args.includes("--child-arg=@playwright/mcp@latest"), `got: ${installer.args}`);

  // ====== Summary ======
  console.log(`\n=== Results: ${PASS.length} passed, ${FAIL.length} failed ===`);
  if (FAIL.length > 0) {
    console.log("\nFailures:");
    for (const f of FAIL) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
  }
  process.exit(FAIL.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
