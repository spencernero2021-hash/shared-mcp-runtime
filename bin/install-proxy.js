#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyPath = path.resolve(__dirname, "../mcp.proxy.js");

const PRESETS = {
  playwright: {
    name: "playwright",
    packageName: "@playwright/mcp@latest",
  },
};

function usage() {
  console.log(`Usage:
  shared-mcp-install --config <path-to-.mcp.json> --preset playwright
  shared-mcp-install --config <path-to-.mcp.json> --name <server-name> --package <npm-package>

Options:
  --config <path>       MCP config path, e.g. D:\\ClaudeCode\\.mcp.json
  --preset <name>       Built-in preset. Available: ${Object.keys(PRESETS).join(", ")}
  --name <name>         MCP server name to install or update
  --package <pkg>       NPM MCP package, e.g. @playwright/mcp@latest
  --package-arg <arg>   Extra argument passed after the package. Repeat as needed.
  --child-cmd <cmd>     Child MCP command, e.g. npx.cmd, node, python
  --child-arg <arg>     Child MCP argument. Repeat for each argument.
  --child <command>     Full child command line, e.g. "npx.cmd -y @playwright/mcp@latest"
  --interactive, -i     Prompt for values interactively
  --force              Replace an existing server entry with the same name
  --dry-run            Print the updated config without writing it
  --no-backup          Do not create a .bak timestamp backup before writing
  --help               Show this help

Example:
  shared-mcp-install --config D:\\ClaudeCode\\.mcp.json --preset playwright
  shared-mcp-install --config D:\\ClaudeCode\\.mcp.json --name playwright --package @playwright/mcp@latest

Interactive:
  shared-mcp-install --interactive
`);
}

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function splitCommandLine(input) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) parts.push(current);
  if (quote) throw new Error("Unclosed quote in child command");
  return parts;
}

function parseArgs(argv) {
  const out = {
    childArgs: [],
    packageArgs: [],
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
    } else if (key === "--interactive" || key === "-i") {
      out.interactive = true;
    } else if (key === "--force") {
      out.force = true;
    } else if (key === "--dry-run") {
      out.dryRun = true;
    } else if (key === "--no-backup") {
      out.backup = false;
    } else if (key === "--config") {
      out.configPath = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--preset") {
      out.preset = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--name") {
      out.name = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--package") {
      out.packageName = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--package-arg") {
      out.packageArgs.push(value);
      if (inlineValue === undefined) i++;
    } else if (key === "--child-cmd") {
      out.childCmd = value;
      if (inlineValue === undefined) i++;
    } else if (key === "--child-arg") {
      out.childArgs.push(value);
      if (inlineValue === undefined) i++;
    } else if (key === "--child") {
      out.child = value;
      if (inlineValue === undefined) i++;
    } else {
      throw new Error(`Unknown argument: ${raw}`);
    }
  }

  applyPresetAndPackage(out);
  return out;
}

function inferNameFromPackage(packageName) {
  const withoutVersion = packageName.replace(/@[^/@]+$/u, "");
  if (withoutVersion.includes("playwright/mcp")) return "playwright";
  const parts = withoutVersion.split("/");
  return parts.at(-1)?.replace(/^server-/u, "").replace(/[^a-z0-9_-]/giu, "-") || "mcp";
}

function applyPresetAndPackage(out) {
  if (out.preset) {
    const preset = PRESETS[out.preset];
    if (!preset) {
      throw new Error(`Unknown preset: ${out.preset}. Available presets: ${Object.keys(PRESETS).join(", ")}`);
    }
    out.name ||= preset.name;
    out.packageName ||= preset.packageName;
  }

  if (out.packageName && !out.childCmd && out.childArgs.length === 0) {
    out.name ||= inferNameFromPackage(out.packageName);
    out.childCmd = npxCommand();
    out.childArgs = ["-y", out.packageName, ...out.packageArgs];
  }

  if (out.child) {
    const parts = splitCommandLine(out.child);
    out.childCmd = out.childCmd || parts[0];
    if (out.childArgs.length === 0) out.childArgs = parts.slice(1);
  }
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

function defaultConfigPath() {
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push("D:\\ClaudeCode\\.mcp.json");
  }
  candidates.push(path.join(process.cwd(), ".mcp.json"));
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function defaultChildCommand(name) {
  if (name === "playwright") {
    return `${npxCommand()} -y @playwright/mcp@latest`;
  }
  return `${npxCommand()} -y <mcp-package>`;
}

async function promptForOptions(options) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (label, defaultValue = "") => {
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      const answer = await rl.question(`${label}${suffix}: `);
      return answer.trim() || defaultValue;
    };
    const yesNo = async (label, defaultValue = true) => {
      const suffix = defaultValue ? "Y/n" : "y/N";
      const answer = (await rl.question(`${label} (${suffix}): `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      return answer === "y" || answer === "yes";
    };

    options.configPath ||= await ask("MCP config path", defaultConfigPath());
    const installTarget = await ask("Preset or npm package", options.preset || options.packageName || "playwright");
    if (PRESETS[installTarget]) {
      options.preset = installTarget;
    } else {
      options.packageName = installTarget;
    }
    applyPresetAndPackage(options);
    options.name ||= await ask("MCP server name", "playwright");

    if (!options.childCmd || options.childArgs.length === 0) {
      const child = await ask("Original child MCP command", defaultChildCommand(options.name));
      const parts = splitCommandLine(child);
      options.childCmd = parts[0];
      options.childArgs = parts.slice(1);
    }

    const configPath = path.resolve(options.configPath);
    const existingConfig = readConfig(configPath);
    if (existingConfig.mcpServers?.[options.name] && !options.force) {
      options.force = await yesNo(`MCP server '${options.name}' already exists. Replace it`, false);
    }
    options.backup = await yesNo("Create backup before writing", options.backup);
  } finally {
    rl.close();
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (options.interactive) {
    await promptForOptions(options);
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
  await main();
} catch (error) {
  console.error(`shared-mcp-install: ${error.message}`);
  console.error("Run with --help for usage.");
  process.exit(1);
}
