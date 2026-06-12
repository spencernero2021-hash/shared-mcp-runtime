# shared-mcp-runtime

A stage-aware MCP tool exposure runtime for reducing MCP Tax.

`shared-mcp-runtime` is designed for MCP-based agents that suffer from tool
schema overload. Instead of exposing every business tool as soon as an MCP
server starts, it keeps the server in an idle state, exposes only control tools,
and reveals task-specific tools only when the agent enters the relevant stage.

The core idea is simple:

```text
idle
  -> set_task_context / activate_domain
  -> expose only the tools needed for the current stage
  -> work
  -> clear_task_context
  -> idle
```

This reduces the hidden cost of full tool exposure: token overhead, attention
competition, accidental tool calls, and long-context degradation.

## Why

Traditional MCP usage often looks like this:

```text
MCP server starts
  -> all tool schemas are injected into the agent context
  -> the model chooses from every available tool
```

That is fine for a small tool set. It becomes fragile when an agent uses many
MCP servers and dozens or hundreds of tools. Tool descriptions and input schemas
become part of the model's working context, even when most of them are irrelevant
to the current task.

`shared-mcp-runtime` treats tool visibility as part of context engineering:

- Business tools are hidden by default.
- The agent declares the current task or stage.
- The server dynamically exposes only relevant tools.
- The tool set can be cleared after the stage or task ends.

## Core Concepts

### `set_task_context`

Sets the current task context, such as skill, goal, stage, language, or file
type. Tool providers can use this context to decide which tools should be
visible.

### `activate_domain`

A lightweight domain switch for simpler MCP servers that only need idle/active
behavior.

### `clear_task_context`

Clears active task/domain state and returns the MCP server to idle mode.

### `action`

An optional `set_task_context` field that immediately executes the first tool
for a stage after the context is set. This reduces the one-turn delay caused by
dynamic `tools/list` refreshes.

### `mcp.proxy.js`

A wrapper for third-party MCP servers. It adds idle-mode gating without changing
the child server's source code.

## Basic Usage

```js
import { createMcpServer } from "@codex/shared-mcp-runtime";

const server = createMcpServer({
  name: "example-mcp",
  version: "0.1.0",
  listChanged: true,
  enableTaskContext: true,
  toolProvider: async (ctx) => {
    if (!ctx.task.hasTask) {
      return { tools: [], handlers: [] };
    }

    if (ctx.task.stage !== "generation") {
      return { tools: [], handlers: [] };
    }

    return {
      tools: [
        {
          name: "hello",
          description: "Say hello during the generation stage.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: [
        {
          name: "hello",
          handler: async () => ({
            content: [{ type: "text", text: "hello" }],
          }),
        },
      ],
    };
  },
});

server.run();
```

In this example, `hello` is not visible while the server is idle. It appears only
after the agent sets a task context whose stage is `generation`.

## Proxy Usage

Both separated and equals-style arguments are supported:

```bash
node ./mcp.proxy.js \
  --name=playwright \
  --child-cmd=npx \
  --child-arg=-y \
  --child-arg=@playwright/mcp@latest
```

On Windows, use `npx.cmd` as the child command if your MCP host does not resolve
`.cmd` shims automatically.

Example `.mcp.json` entry:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": [
        "path/to/shared-mcp-runtime/mcp.proxy.js",
        "--name=playwright",
        "--child-cmd=npx",
        "--child-arg=-y",
        "--child-arg=@playwright/mcp@latest"
      ]
    }
  }
}
```

## What This Is Not

This project is not primarily a generic JSON-RPC boilerplate library.

It does include the protocol handling needed to run MCP servers, but that is an
implementation detail. The main purpose is dynamic tool exposure and MCP context
governance.

For heavy execution work, a good pattern is:

```text
MCP: thin, stage-aware capability entry
CLI/script: heavy execution engine
Skill/prompt: task routing and workflow policy
```

## Verify

```bash
npm test
```

## Context Engineering Report

See [docs/mcp_context_engineering_report.md](docs/mcp_context_engineering_report.md)
for the tool-exposure analysis, migration notes, and validation results.
