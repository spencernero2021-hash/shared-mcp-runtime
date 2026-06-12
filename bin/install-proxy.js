#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyPath = path.resolve(__dirname, "../mcp.proxy.js");

function usage() {
  console.log(`Usage:
  shared-mcp-install --config <path-to-.mcp.json> --name <server-name> --child-cmd <cmd> --child-arg <arg>...

Options:
  --config <path>       MCP config path, e.g. D:\\ClaudeCode\\.mcp.json
  --name <name>         MCP server name to install or update
  --child-cmd <cmd>     Child MCP command, e.g. npx.cmd, node, python
  --child-arg <arg>     Child MCP argument. Repeat for each argument.
  --force              Replace an existing server entry with the same name
  --dry-run            Print the updated config without writing it
  --no-backup          Do not create a .bak timestamp backup before writing
  --help               Show this help

Example:
  shared-mcp-install --config D:\\ClaudeCode\\.mcp.json --name playwright --child-cmd npx.cmd --child-arg -y --child-arg @playwright/mcp@latest
`);
}

function parseArgs(argv) {
  const out = {
    childArgs: [],
    force: false,
    dryRun: false,
    backup: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const [key, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = inlineValue ?? argv[i + 1];

    if (key === "--help" || key === "-h") {
      out.help = true;
    } else if (key === "--force") {
      out.force = true;
    } else if (key === "--dry-run") {
      out.dryRun = true;
    } else if (key === "--no-backup") {
      out.backup = false;
    } else if (key === "--config") {
      out.configPath = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--name") {
      out.name = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--child-cmd") {
      out.childCmd = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--child-arg") {
      out.childArgs.push(value);
      if (inlineValue === undefined) i++;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }

  return out;
}

function requireValue(options, key) {
  if (!options[key]) throw new Error(`Missing required option: --${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(configPath, "utf8");
  if (!raw.trim()) return { mcpServers: {} };
  const parsed = JSON.parse(raw);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
    parsed.mcpServers = {};
  }
  return parsed;
}

function makeEntry(options) {
  return {
    command: "node",
    args: [
      proxyPath,
      `--name=${options.name}`,
      `--child-cmd=${options.childCmd}`,
      ...options.childArgs.map((arg) => `--child-arg=${arg}`),
    ],
  };
}

function backupConfig(configPath) {
  if (!fs.existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak.${stamp}`;
  fs.copyFileSync(configPath, backupPath);
  return backupPath;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  requireValue(options, "configPath");
  requireValue(options, "name");
  requireValue(options, "childCmd");
  if (options.childArgs.length === 0) {
    throw new Error("Missing required option: --child-arg");
  }

  const configPath = path.resolve(options.configPath);
  const config = readConfig(configPath);
  const existing = config.mcpServers[options.name];
  if (existing && !options.force) {
    throw new Error(`MCP server '${options.name}' already exists. Use --force to replace it.`);
  }

  config.mcpServers[options.name] = makeEntry(options);
  const output = `${JSON.stringify(config, null, 2)}\n`;

  if (options.dryRun) {
    process.stdout.write(output);
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const backupPath = options.backup ? backupConfig(configPath) : null;
  fs.writeFileSync(configPath, output, "utf8");

  console.log(`Installed dynamic MCP proxy '${options.name}' into ${configPath}`);
  if (backupPath) console.log(`Backup: ${backupPath}`);
  console.log("Restart or refresh your MCP host to load the updated config.");
}

try {
  main();
} catch (error) {
  console.error(`shared-mcp-install: ${error.message}`);
  console.error("Run with --help for usage.");
  process.exit(1);
}
