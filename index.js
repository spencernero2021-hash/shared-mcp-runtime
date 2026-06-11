#!/usr/bin/env node

/**
 * Shared MCP Runtime v0.2.0
 *
 * A lightweight JSON-RPC 2.0 runtime for MCP servers with:
 *   - list_changed notification support (dynamic tool exposure)
 *   - Domain-based tool expansion (progressive disclosure)
 *   - Task context + stage-aware tool filtering
 *   - activate_domain / set_task_context built-in tools
 *   - Standard error classification with actionable suggestions
 *   - Call-pattern observation (server-side self-deliberation)
 *
 * Usage:
 *   import { createMcpServer } from "../../shared-mcp-runtime/index.js";
 *   const server = createMcpServer({ name, version, toolProvider, enableTaskContext: true, ... });
 *   server.run();
 */

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Error classification (unchanged)
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  [/timed?\s*out|ETIMEDOUT|timeout/i, "timeout"],
  [/eligibility|not eligible|region|location/i, "eligibility"],
  [/auth|unauthorized|forbidden|401|403|key.*invalid/i, "auth"],
  [/ECONNREFUSED|ENOTFOUND|connect|network|fetch failed/i, "network"],
  [/validation|invalid|schema|required/i, "validation"],
  [/rate.limit|too many|429/i, "rate_limit"],
  [/image.*format|unsupported.*format|not a valid image/i, "image_format"],
  [/spawn|ENOENT|command not found|not found/i, "dependency"],
  [/out of memory|memory/i, "memory"],
];

function classifyError(error) {
  const message = String(error?.message || error || "");
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return "unknown";
}

const DEFAULT_SUGGESTIONS = {
  timeout: "Increase timeout or reduce batch size.",
  eligibility: "Check account/location eligibility in the external tool.",
  auth: "Verify API keys and authentication credentials.",
  network: "Check that the required service is running and reachable.",
  validation: "Verify the input arguments against the tool schema.",
  rate_limit: "Wait and retry; reduce request frequency.",
  image_format: "Provide a supported image format (PNG, JPG, BMP, TIFF).",
  dependency: "Verify the required external command is installed and on PATH.",
  memory: "Reduce input size or free system memory.",
  unknown: "Check MCP server logs for details.",
};

function suggestionFor(errorType) {
  return DEFAULT_SUGGESTIONS[errorType] || DEFAULT_SUGGESTIONS.unknown;
}

// ---------------------------------------------------------------------------
// Built-in tool definitions
// ---------------------------------------------------------------------------

const ACTIVATE_DOMAIN_TOOL = {
  name: "activate_domain",
  description:
    "ACTIVATE this MCP server's full toolset. Call this FIRST when a task needs this server's domain capabilities. " +
    "The expanded tools become available in the next conversation turn.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Domain to activate. Check the server's documentation for available domains.",
      },
    },
    required: ["domain"],
    additionalProperties: false,
  },
};

const SET_TASK_CONTEXT_TOOL = {
  name: "set_task_context",
  description:
    "Tell this MCP server what task you are working on. The server will expose stage-appropriate tools and optimize defaults. " +
    "Call this BEFORE starting work in a domain. Update it when the task stage changes. " +
    "Optionally pass 'action' + 'action_args' to execute the first tool of the new stage immediately, avoiding a one-turn delay.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "The skill name driving this task, e.g. courseware-study, market-intel, design-ppt.",
      },
      goal: {
        type: "string",
        description: "One-sentence description of what the user wants.",
      },
      stage: {
        type: "string",
        description: "Current task stage. Domain-specific. Examples: intake, extraction, generation, research, data_collection, scoring, reporting.",
      },
      language: {
        type: "string",
        description: "Primary output language. Examples: zh-CN, en-US.",
      },
      file_type: {
        type: "string",
        description: "If processing a file, its type. Examples: pdf, pptx, ppt.",
      },
      action: {
        type: "string",
        description: "Optional: name of the first tool to execute immediately after setting this context. Avoids one-turn delay.",
      },
      action_args: {
        type: "object",
        description: "Optional: arguments for the action tool.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },
};

const CLEAR_TASK_CONTEXT_TOOL = {
  name: "clear_task_context",
  description:
    "Reset this MCP server to idle state. Hides all domain-specific tools. " +
    "Call this when the current task is complete or when switching to a completely different domain.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Core runtime
// ---------------------------------------------------------------------------

function createMcpServer(options) {
  const {
    name,
    version,
    toolProvider,
    listChanged: enableListChanged = false,
    enableTaskContext = false,
    verbose = false,
  } = options;

  // --- internal state ---
  let currentTools = [];
  let currentHandlers = new Map();
  const activeDomains = new Set();
  const callLog = [];
  const MAX_CALL_LOG = 50;

  // Task context (rich, vs domain which is boolean)
  const taskContext = {
    skill: null,
    goal: null,
    stage: null,
    language: null,
    fileType: null,
  };

  // --- messaging ---
  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function log(msg) {
    if (verbose) process.stderr.write(`[${name}] ${msg}\n`);
  }

  // --- tool list update ---

  async function refreshTools() {
    const prevNames = new Set(currentTools.map((t) => t.name));

    const ctx = createContext();
    const { tools, handlers } = await toolProvider(ctx);

    // Prepend built-in tools if task context is enabled
    let allTools = [...tools];
    if (enableTaskContext) {
      const isIdle = activeDomains.size === 0 && !taskContext.skill;
      const isActive = activeDomains.size > 0 || taskContext.skill;
      if (isIdle) {
        allTools.unshift(SET_TASK_CONTEXT_TOOL);
        allTools.unshift(ACTIVATE_DOMAIN_TOOL);
      }
      if (isActive) {
        allTools.unshift(SET_TASK_CONTEXT_TOOL);  // stage switching
        allTools.unshift(CLEAR_TASK_CONTEXT_TOOL); // cleanup
      }
    }

    currentTools = allTools;
    currentHandlers = new Map();

    // Register built-in tool handlers (they take precedence)
    if (enableTaskContext) {
      currentHandlers.set("activate_domain", activateDomainHandler);
      currentHandlers.set("set_task_context", setTaskContextHandler);
      currentHandlers.set("clear_task_context", clearTaskContextHandler);
    }

    // Register user-provided handlers. Built-ins are the control plane and must
    // not be shadowed by domain tools with the same name.
    for (const h of handlers) {
      if (currentHandlers.has(h.name)) {
        log(`skipping tool '${h.name}' because it conflicts with a built-in control tool`);
        continue;
      }
      currentHandlers.set(h.name, h.handler);
    }

    const newNames = new Set(currentTools.map((t) => t.name));
    const added = [...newNames].filter((n) => !prevNames.has(n));
    const removed = [...prevNames].filter((n) => !newNames.has(n));

    if (added.length > 0 || removed.length > 0) {
      log(`tools refreshed: +${added.join(",") || "none"} -${removed.join(",") || "none"}`);
      return { changed: true, added, removed };
    }
    return { changed: false, added: [], removed: [] };
  }

  function emitListChanged() {
    send({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: {},
    });
    log("emitted tools/list_changed");
  }

  // --- built-in tool handlers ---

  const activateDomainHandler = async (args, ctx) => {
    const domain = args.domain;
    if (!domain) {
      return {
        content: [{ type: "text", text: "Error: domain is required. Available domains depend on the server. Check server documentation." }],
        structuredContent: { ok: false, error: "missing_domain" },
      };
    }
    await ctx.expandDomain(domain);
    return {
      content: [{ type: "text", text: `Domain activated: ${domain}. Full toolset available next turn.` }],
      structuredContent: { ok: true, domain, expanded: true },
    };
  };

  const setTaskContextHandler = async (args, _ctx) => {
    taskContext.skill = args.skill || null;
    taskContext.goal = args.goal || null;
    taskContext.stage = args.stage || null;
    taskContext.language = args.language || null;
    taskContext.fileType = args.file_type || null;

    log(`task context: skill=${taskContext.skill} stage=${taskContext.stage}`);

    // Refresh tools for the new stage
    const { changed } = await refreshTools();
    if (changed && enableListChanged) {
      emitListChanged();
    }

    // If an action is specified, execute it immediately in the new stage
    if (args.action) {
      const handler = currentHandlers.get(args.action);
      if (!handler) {
        const available = [...currentHandlers.keys()].join(", ");
        return {
          content: [{ type: "text", text: `Stage set to '${taskContext.stage}', but action '${args.action}' is not available here. Available tools in this stage: ${available || "none"}` }],
          structuredContent: { ok: false, ...taskContext, error_type: "action_unavailable", action: args.action, available_tools: available },
        };
      }
      try {
        const startedAt = Date.now();
        const actionArgs = args.action_args || {};
        const result = await handler(actionArgs, createContext());
        log(`action ${args.action} OK (${Date.now() - startedAt}ms)`);
        return {
          content: result.content || [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { ok: true, ...taskContext, action: args.action, action_result: result.structuredContent || null },
        };
      } catch (error) {
        const errorType = classifyError(error);
        const message = String(error?.message || error || `Action ${args.action} failed`);
        log(`action ${args.action} FAILED (${errorType}): ${message}`);
        return {
          content: [{ type: "text", text: `Stage set, but action failed (${errorType}): ${message}\n${suggestionFor(errorType)}` }],
          structuredContent: { ok: false, ...taskContext, action: args.action, error_type: errorType, message },
        };
      }
    }

    // No action — just context switch
    const stageInfo = taskContext.stage ? `, stage: ${taskContext.stage}` : "";
    return {
      content: [{ type: "text", text: `Task context set: ${taskContext.skill}${stageInfo}. Stage-appropriate tools available next turn.` }],
      structuredContent: { ok: true, ...taskContext },
    };
  };

  const clearTaskContextHandler = async (_args, _ctx) => {
    taskContext.skill = null;
    taskContext.goal = null;
    taskContext.stage = null;
    taskContext.language = null;
    taskContext.fileType = null;
    activeDomains.clear();

    log("task context cleared, returning to idle");

    const { changed } = await refreshTools();
    if (changed && enableListChanged) {
      emitListChanged();
    }

    return {
      content: [{ type: "text", text: "Task context cleared. All domain tools hidden. Back to idle." }],
      structuredContent: { ok: true, cleared: true },
    };
  };

  // --- context ---

  function createContext() {
    return {
      get domains() {
        return activeDomains;
      },
      get callLog() {
        return [...callLog];
      },
      get task() {
        return {
          skill: taskContext.skill,
          goal: taskContext.goal,
          stage: taskContext.stage,
          language: taskContext.language,
          fileType: taskContext.fileType,
          get hasTask() {
            return !!taskContext.skill;
          },
        };
      },
      hasDomain(domain) {
        return activeDomains.has(domain);
      },
      async expandDomain(domain) {
        if (activeDomains.has(domain)) return;
        activeDomains.add(domain);
        log(`domain expanded: ${domain}`);
        const { changed } = await refreshTools();
        if (changed && enableListChanged) {
          emitListChanged();
        }
      },
    };
  }

  // --- request dispatch ---

  async function handle(request) {
    const { id, method, params } = request;

    if (method === "initialize") {
      const capabilities = { tools: {} };
      if (enableListChanged) {
        capabilities.tools.listChanged = true;
      }
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities,
          serverInfo: { name, version },
        },
      };
    }

    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: currentTools } };
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const startedAt = Date.now();

      const handler = currentHandlers.get(toolName);
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Unknown tool: ${toolName}. Available: ${[...currentHandlers.keys()].join(", ")}`,
          },
        };
      }

      callLog.push({ tool: toolName, timestamp: startedAt });
      if (callLog.length > MAX_CALL_LOG) callLog.shift();

      try {
        const ctx = createContext();
        const result = await handler(args, ctx);

        log(`tool ${toolName} OK (${Date.now() - startedAt}ms)`);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: result.content || [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result.structuredContent || undefined,
          },
        };
      } catch (error) {
        const errorType = classifyError(error);
        const message = String(error?.message || error || `Tool ${toolName} failed`);
        const elapsed = Date.now() - startedAt;

        log(`tool ${toolName} FAILED (${errorType}, ${elapsed}ms): ${message}`);

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `${name} failed (${errorType}): ${message}\nSuggestion: ${suggestionFor(errorType)}`,
              },
            ],
            structuredContent: {
              ok: false,
              tool: toolName,
              elapsed_ms: elapsed,
              error_type: errorType,
              message,
              suggestion: suggestionFor(errorType),
            },
          },
        };
      }
    }

    if (id === undefined) return null;

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  // --- lifecycle ---

  async function run() {
    log("starting...");
    const { changed } = await refreshTools();
    log(`initialized with ${currentTools.length} tools`);
    if (changed && enableListChanged && activeDomains.size > 0) {
      emitListChanged();
    }

    const rl = createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      if (!line.trim()) return;

      let request;
      try {
        request = JSON.parse(line);
      } catch (error) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
        return;
      }

      try {
        const response = await handle(request);
        if (response) send(response);
      } catch (error) {
        log(`unhandled error: ${error.message}`);
        send({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32000, message: error.message } });
      }
    });

    process.on("SIGTERM", () => { rl.close(); process.exit(0); });
    process.on("SIGINT", () => { rl.close(); process.exit(0); });
  }

  return {
    run,
    async updateTools() {
      const { changed } = await refreshTools();
      if (changed && enableListChanged) emitListChanged();
    },
    getTools() {
      return [...currentTools];
    },
    getDomains() {
      return new Set(activeDomains);
    },
  };
}

export { createMcpServer, classifyError, suggestionFor };
