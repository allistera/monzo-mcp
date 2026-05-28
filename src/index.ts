#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runAuthFlow } from "./auth.js";
import { tools, type ToolDef } from "./tools.js";

function schemaToJson(tool: ToolDef): Record<string, unknown> {
  const json = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

async function runServer(): Promise<void> {
  const mode = (process.env.MONZO_MODE ?? "read").toLowerCase();
  if (mode !== "read" && mode !== "write") {
    throw new Error(`MONZO_MODE must be 'read' or 'write', got '${mode}'`);
  }
  const enabled = tools.filter((t) => mode === "write" || t.mode === "read");
  const byName = new Map(enabled.map((t) => [t.name, t]));

  const server = new Server(
    { name: "monzo-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: enabled.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: schemaToJson(t),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      throw new Error(
        `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
      );
    }
    try {
      const result = await tool.handler(parsed.data);
      return {
        content: [
          {
            type: "text",
            text:
              typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `monzo-mcp running on stdio (mode=${mode}, tools=${enabled.length})\n`,
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
