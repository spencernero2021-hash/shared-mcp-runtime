/**
 * shared-mcp-runtime
 *
 * Stage-aware tool exposure primitives for MCP-style agents.
 *
 * This module intentionally focuses on tool visibility, task context, and
 * tool lifecycle management. Transport/protocol handling belongs in host
 * adapters, not in the core runtime.
 */

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

const ACTIVATE_DOMAIN_TOOL = {
  name: "activate_domain",
  description:
    "Activate this MCP server's domain tools. Call this first when a task needs this domain. " +
    "The expanded tools become available after the tool list refreshes.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "Domain to activate. Check the server documentation for available domains.",
      },
    },
    required: ["domain"],
    additionalProperties: false,
  },
};

const SET_TASK_CONTEXT_TOOL = {
  name: "set_task_context",
  description:
    "Set the current task context so this MCP server can expose stage-appropriate tools. " +
    "Update this when the task stage changes. Optionally pass action + action_args to execute the first tool immediately.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Skill or workflow driving this task, e.g. courseware-study, market-intel, design-ppt.",
      },
      goal: {
        type: "string",
        description: "One-sentence description of what the user wants.",
      },
      stage: {
        type: "string",
        description: "Current task stage, e.g. intake, extraction, generation, research, scoring, reporting.",
      },
      language: {
        type: "string",
        description: "Primary output language, e.g. zh-CN or en-US.",
      },
      file_type: {
        type: "string",
        description: "If processing a file, its type, e.g. pdf, pptx, docx.",
      },
      action: {
        type: "string",
        description: "Optional first tool to execute immediately after setting context.",
      },
      action_args: {
        type: "object",
        description: "Optional arguments for the action tool.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },
};

const CLEAR_TASK_CONTEXT_TOOL = {
  name: "clear_task_context",
  description:
    "Reset this MCP server to idle state and hide domain-specific tools. Call this when the current task is complete.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

const CONTROL_TOOL_NAMES = new Set([
  ACTIVATE_DOMAIN_TOOL.name,
  SET_TASK_CONTEXT_TOOL.name,
  CLEAR_TASK_CONTEXT_TOOL.name,
]);

function classifyError(error) {
  const message = String(error?.message || error || "");
  for (const [pattern, type] of ERROR_PATTERNS) {
    if (pattern.test(message)) return type;
  }
  return "unknown";
}

function suggestionFor(errorType) {
  return DEFAULT_SUGGESTIONS[errorType] || DEFAULT_SUGGESTIONS.unknown;
}

function createEmptyTaskContext() {
  return {
    skill: null,
    goal: null,
    stage: null,
    language: null,
    fileType: null,
  };
}

function cloneTaskContext(taskContext) {
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
}

function makeToolSetDelta(previousTools, nextTools) {
  const prevNames = new Set(previousTools.map((tool) => tool.name));
  const nextNames = new Set(nextTools.map((tool) => tool.name));
  const added = [...nextNames].filter((name) => !prevNames.has(name));
  const removed = [...prevNames].filter((name) => !nextNames.has(name));
  return {
    changed: added.length > 0 || removed.length > 0,
    added,
    removed,
  };
}

function normalizeTaskArgs(args = {}) {
  return {
    skill: args.skill || null,
    goal: args.goal || null,
    stage: args.stage || null,
    language: args.language || null,
    fileType: args.file_type || args.fileType || null,
  };
}

function createToolExposureRuntime(options) {
  const {
    name = "tool-exposure-runtime",
    toolProvider,
    enableTaskContext = true,
    onToolsChanged,
    verbose = false,
  } = options;

  if (typeof toolProvider !== "function") {
    throw new TypeError("toolProvider must be a function");
  }

  let currentTools = [];
  let currentHandlers = new Map();
  const activeDomains = new Set();
  const taskContext = createEmptyTaskContext();
  const callLog = [];
  const MAX_CALL_LOG = 50;

  function log(message) {
    if (verbose) process.stderr.write(`[${name}] ${message}\n`);
  }

  function createContext() {
    return {
      get domains() {
        return activeDomains;
      },
      get callLog() {
        return [...callLog];
      },
      get task() {
        return cloneTaskContext(taskContext);
      },
      hasDomain(domain) {
        return activeDomains.has(domain);
      },
      async expandDomain(domain) {
        if (activeDomains.has(domain)) return { changed: false, added: [], removed: [] };
        activeDomains.add(domain);
        log(`domain expanded: ${domain}`);
        return refreshTools();
      },
    };
  }

  async function refreshTools() {
    const previousTools = currentTools;
    const ctx = createContext();
    const provided = await toolProvider(ctx);
    const tools = provided?.tools || [];
    const handlers = provided?.handlers || [];

    let allTools = [...tools];
    const handlersByName = new Map();

    if (enableTaskContext) {
      const isIdle = activeDomains.size === 0 && !taskContext.skill;
      const isActive = activeDomains.size > 0 || !!taskContext.skill;

      if (isIdle) {
        allTools.unshift(SET_TASK_CONTEXT_TOOL);
        allTools.unshift(ACTIVATE_DOMAIN_TOOL);
      }

      if (isActive) {
        allTools.unshift(SET_TASK_CONTEXT_TOOL);
        allTools.unshift(CLEAR_TASK_CONTEXT_TOOL);
      }

      handlersByName.set(ACTIVATE_DOMAIN_TOOL.name, activateDomain);
      handlersByName.set(SET_TASK_CONTEXT_TOOL.name, setTaskContext);
      handlersByName.set(CLEAR_TASK_CONTEXT_TOOL.name, clearTaskContext);
    }

    for (const item of handlers) {
      if (CONTROL_TOOL_NAMES.has(item.name)) {
        log(`skipping '${item.name}' because it conflicts with a control tool`);
        continue;
      }
      handlersByName.set(item.name, item.handler);
    }

    currentTools = allTools;
    currentHandlers = handlersByName;

    const delta = makeToolSetDelta(previousTools, currentTools);
    if (delta.changed) {
      log(`tools changed: +${delta.added.join(",") || "none"} -${delta.removed.join(",") || "none"}`);
      if (typeof onToolsChanged === "function") {
        await onToolsChanged(delta, createContext());
      }
    }
    return delta;
  }

  async function activateDomain(args = {}) {
    const domain = args.domain;
    if (!domain) {
      return {
        content: [{ type: "text", text: "Error: domain is required." }],
        structuredContent: { ok: false, error: "missing_domain" },
      };
    }

    await createContext().expandDomain(domain);
    return {
      content: [{ type: "text", text: `Domain activated: ${domain}.` }],
      structuredContent: { ok: true, domain, expanded: true },
    };
  }

  async function setTaskContext(args = {}) {
    Object.assign(taskContext, normalizeTaskArgs(args));
    log(`task context: skill=${taskContext.skill} stage=${taskContext.stage}`);

    await refreshTools();

    if (args.action) {
      return callTool(args.action, args.action_args || {}, { actionSource: SET_TASK_CONTEXT_TOOL.name });
    }

    const stageInfo = taskContext.stage ? `, stage: ${taskContext.stage}` : "";
    return {
      content: [{ type: "text", text: `Task context set: ${taskContext.skill}${stageInfo}.` }],
      structuredContent: { ok: true, ...cloneTaskContext(taskContext) },
    };
  }

  async function clearTaskContext() {
    taskContext.skill = null;
    taskContext.goal = null;
    taskContext.stage = null;
    taskContext.language = null;
    taskContext.fileType = null;
    activeDomains.clear();

    await refreshTools();
    return {
      content: [{ type: "text", text: "Task context cleared. Back to idle." }],
      structuredContent: { ok: true, cleared: true },
    };
  }

  async function callTool(toolName, args = {}, options = {}) {
    const handler = currentHandlers.get(toolName);
    if (!handler) {
      const available = [...currentHandlers.keys()];
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}. Available: ${available.join(", ") || "none"}` }],
        structuredContent: {
          ok: false,
          error_type: "unknown_tool",
          tool: toolName,
          available_tools: available,
        },
      };
    }

    const startedAt = Date.now();
    callLog.push({ tool: toolName, timestamp: startedAt, source: options.actionSource || "direct" });
    if (callLog.length > MAX_CALL_LOG) callLog.shift();

    try {
      return await handler(args, createContext());
    } catch (error) {
      const errorType = classifyError(error);
      const message = String(error?.message || error || `Tool ${toolName} failed`);
      return {
        content: [
          {
            type: "text",
            text: `${toolName} failed (${errorType}): ${message}\nSuggestion: ${suggestionFor(errorType)}`,
          },
        ],
        structuredContent: {
          ok: false,
          tool: toolName,
          elapsed_ms: Date.now() - startedAt,
          error_type: errorType,
          message,
          suggestion: suggestionFor(errorType),
        },
      };
    }
  }

  return {
    refreshTools,
    updateTools: refreshTools,
    getTools() {
      return [...currentTools];
    },
    getHandlers() {
      return new Map(currentHandlers);
    },
    getDomains() {
      return new Set(activeDomains);
    },
    getTaskContext() {
      return cloneTaskContext(taskContext);
    },
    getCallLog() {
      return [...callLog];
    },
    activateDomain,
    setTaskContext,
    clearTaskContext,
    callTool,
  };
}

export {
  ACTIVATE_DOMAIN_TOOL,
  SET_TASK_CONTEXT_TOOL,
  CLEAR_TASK_CONTEXT_TOOL,
  createToolExposureRuntime,
  classifyError,
  suggestionFor,
};
