#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runAuthFlow } from "./auth.js";
import { createMonzoServer, enabledToolCount, parseMode } from "./server.js";

interface PackageMetadata {
  version: string;
}

async function packageVersion(): Promise<string> {
  const path = new URL("../package.json", import.meta.url);
  const metadata = JSON.parse(await readFile(path, "utf8")) as PackageMetadata;
  return metadata.version;
}

async function runServer(): Promise<void> {
  const mode = parseMode(process.env.MONZO_MODE);
  const version = await packageVersion();

  serveStdio(() => createMonzoServer(mode, version));
  process.stderr.write(
    `monzo-mcp running on stdio (mode=${mode}, tools=${enabledToolCount(mode)}, MCP=2026-07-28 with legacy fallback)\n`,
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "auth") {
    await runAuthFlow();
    return;
  }
  if (cmd && cmd !== "serve") {
    process.stderr.write(
      `Usage:\n  monzo-mcp auth    # run OAuth2 flow once\n  monzo-mcp         # run the MCP server on stdio\n`,
    );
    process.exit(cmd === "--help" || cmd === "-h" ? 0 : 1);
  }
  await runServer();
}

main().catch((err) => {
  process.stderr.write(
    (err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n",
  );
  process.exit(1);
});
