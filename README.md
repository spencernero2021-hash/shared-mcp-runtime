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
import { createToolExposureRuntime } from "shared-mcp-runtime";

const exposure = createToolExposureRuntime({
  name: "example-mcp",
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

await exposure.refreshTools();
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

## One-Command Install

The easiest path is interactive install:

```bash
npx shared-mcp-runtime@latest --interactive
```

Equivalent npm exec form:

```bash
npm exec --package shared-mcp-runtime@latest -- shared-mcp-install --interactive
```

It asks for the MCP config path, server name, and the original child MCP command,
then writes the dynamic proxy entry for you.

You can also use `shared-mcp-install` after global install:

```bash
npm install -g shared-mcp-runtime
shared-mcp-install --interactive
```

For scripted setup, pass all values directly. The installer writes a dynamic
proxy entry into an MCP config file and wraps an existing child MCP server
without changing the child server's source code.

```bash
shared-mcp-install \
  --config /path/to/.mcp.json \
  --name playwright \
  --child-cmd npx \
  --child-arg -y \
  --child-arg @playwright/mcp@latest
```

Windows example:

```powershell
shared-mcp-install `
  --config D:\ClaudeCode\.mcp.json `
  --name playwright `
  --child-cmd npx.cmd `
  --child-arg -y `
  --child-arg @playwright/mcp@latest
```

If the server name already exists, add `--force` to replace it. The installer
creates a timestamped backup by default before writing the config.

For local development without a global install:

```bash
node ./bin/install-proxy.js --config /path/to/.mcp.json --name playwright --child-cmd npx --child-arg -y --child-arg @playwright/mcp@latest
```

You can preview without writing:

```bash
npx shared-mcp-runtime@latest --config /path/to/.mcp.json --name playwright --child "npx -y @playwright/mcp@latest" --dry-run
```

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

This project is not a generic JSON-RPC boilerplate library.

The core module does not try to own MCP transport/protocol handling. It focuses
on dynamic tool exposure and MCP context governance. Host adapters can connect
these primitives to stdio MCP, HTTP MCP, SDK-based servers, or custom harnesses.

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

## Publish

The package is prepared for npm as `shared-mcp-runtime`.

Before the first publish:

```bash
npm login
npm publish
```

To verify the publish package contents without publishing:

```bash
npm pack --dry-run
```

## Context Engineering Report

See [docs/mcp_context_engineering_report.md](docs/mcp_context_engineering_report.md)
for the tool-exposure analysis, migration notes, and validation results.
