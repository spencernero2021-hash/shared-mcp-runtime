# shared-mcp-runtime

Lightweight JSON-RPC runtime for MCP servers with stage-aware tool exposure.

## Features

- Dynamic `tools/list` updates through `notifications/tools/list_changed`
- Built-in `activate_domain`, `set_task_context`, and `clear_task_context`
- Optional `action` execution in `set_task_context` to avoid a one-turn delay
- Server-side domain/task context available to tool providers
- Standard error classification and suggestions
- `mcp.proxy.js` wrapper for third-party MCP servers that cannot be modified directly

## Basic Usage

```js
import { createMcpServer } from "../shared-mcp-runtime/index.js";

const server = createMcpServer({
  name: "example-mcp",
  version: "0.1.0",
  listChanged: true,
  enableTaskContext: true,
  toolProvider: async (ctx) => {
    if (!ctx.task.hasTask) return { tools: [], handlers: [] };
    return {
      tools: [
        {
          name: "hello",
          description: "Say hello.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      handlers: [
        {
          name: "hello",
          handler: async () => ({ content: [{ type: "text", text: "hello" }] }),
        },
      ],
    };
  },
});

server.run();
```

## Proxy Usage

Both separated and equals-style arguments are supported:

```powershell
node D:\Codex\New\shared-mcp-runtime\mcp.proxy.js `
  --name=playwright `
  --child-cmd=npx.cmd `
  --child-arg=-y `
  --child-arg=@playwright/mcp@latest
```

## Verify

```bash
npm test
```

## Context Engineering Report

See [docs/mcp_context_engineering_report.md](docs/mcp_context_engineering_report.md) for the tool-exposure analysis, migration notes, and validation results.
