#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runAuthFlow } from "./auth.js";
import { tools, type ToolDef } from "./tools.js";

function schemaToJson(tool: ToolDef): Record<string, unknown> {
  // Lazy import zod via duck typing — read the Zod shape and convert.
  const def: any = (tool.inputSchema as any)._def;
  if (def?.typeName === "ZodObject") {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries<any>(shape)) {
      properties[key] = zodFieldToJson(value);
      if (!value.isOptional()) required.push(key);
    }
    const out: Record<string, unknown> = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    return out;
  }
  return { type: "object" };
}

function zodFieldToJson(field: any): Record<string, unknown> {
  // Unwrap optional/default/nullable.
  while (
    field?._def?.typeName === "ZodOptional" ||
    field?._def?.typeName === "ZodDefault" ||
    field?._def?.typeName === "ZodNullable"
  ) {
    field = field._def.innerType;
  }
  const tn = field?._def?.typeName;
  const description = field?._def?.description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;
  switch (tn) {
    case "ZodString":
      base.type = "string";
      break;
    case "ZodNumber":
      base.type = "number";
      break;
    case "ZodBoolean":
      base.type = "boolean";
      break;
    case "ZodRecord":
      base.type = "object";
      base.additionalProperties = field._def.valueType
        ? zodFieldToJson(field._def.valueType)
        : true;
      break;
    case "ZodArray":
      base.type = "array";
      base.items = zodFieldToJson(field._def.type);
      break;
    case "ZodObject": {
      const shape = field._def.shape();
      const props: Record<string, unknown> = {};
      const req: string[] = [];
      for (const [k, v] of Object.entries<any>(shape)) {
        props[k] = zodFieldToJson(v);
        if (!v.isOptional()) req.push(k);
      }
      base.type = "object";
      base.properties = props;
      base.additionalProperties = false;
      if (req.length) base.required = req;
      break;
    }
    case "ZodAny":
    case "ZodUnknown":
      // leave untyped
      break;
    default:
      // unknown — leave permissive
      break;
  }
  return base;
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
