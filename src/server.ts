import {
  McpServer,
  type JSONValue,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { tools } from "./tools.js";

export type MonzoMode = "read" | "write";

export function parseMode(value: string | undefined): MonzoMode {
  const mode = (value ?? "read").toLowerCase();
  if (mode !== "read" && mode !== "write") {
    throw new Error(`MONZO_MODE must be 'read' or 'write', got '${mode}'`);
  }
  return mode;
}

function titleFor(name: string): string {
  if (name === "whoami") return "Who Am I";
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function annotationsFor(
  mode: MonzoMode,
  annotations: ToolAnnotations | undefined,
): ToolAnnotations {
  return {
    readOnlyHint: mode === "read",
    destructiveHint: mode === "write",
    idempotentHint: mode === "read",
    openWorldHint: true,
    ...annotations,
  };
}

function normalizeResult(result: unknown): JSONValue {
  return result === undefined ? null : (result as JSONValue);
}

export function createMonzoServer(mode: MonzoMode, version: string): McpServer {
  const server = new McpServer({ name: "monzo-mcp", version });
  const enabled = tools.filter(
    (tool) => mode === "write" || tool.mode === "read",
  );

  for (const tool of enabled) {
    server.registerTool(
      tool.name,
      {
        title: titleFor(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: z.json(),
        annotations: annotationsFor(tool.mode, tool.annotations),
      },
      async (args) => {
        try {
          const result = normalizeResult(await tool.handler(args));
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
            structuredContent: result,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  return server;
}

export function enabledToolCount(mode: MonzoMode): number {
  return tools.filter((tool) => mode === "write" || tool.mode === "read")
    .length;
}
