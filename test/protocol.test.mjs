import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const packageMetadata = JSON.parse(
  await readFile(new URL("package.json", projectRoot), "utf8"),
);

function startServer(mode) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, MONZO_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function receive() {
    const message = queue.shift();
    if (message) return Promise.resolve(message);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`Timed out waiting for MCP response. stderr: ${stderr}`),
        );
      }, 2_000);
      waiters.push({
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
      });
    });
  }

  async function close() {
    lines.close();
    child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }

  return { close, receive, send };
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "monzo-mcp-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

test("serves MCP 2026-07-28 over stdio", async (t) => {
  const server = startServer("write");
  t.after(() => server.close());
  const meta = modernMeta();

  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: meta },
  });
  const discover = await server.receive();

  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.equal(discover.result.resultType, "complete");
  assert.equal(discover.result.ttlMs, 0);
  assert.equal(discover.result.cacheScope, "private");
  assert.deepEqual(
    discover.result._meta["io.modelcontextprotocol/serverInfo"],
    { name: "monzo-mcp", version: packageMetadata.version },
  );

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: { _meta: meta },
  });
  const listed = await server.receive();

  assert.equal(listed.result.resultType, "complete");
  assert.equal(listed.result.tools.length, 20);
  const balance = listed.result.tools.find(
    (tool) => tool.name === "get_balance",
  );
  assert.equal(balance.title, "Get Balance");
  assert.deepEqual(balance.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.ok(Array.isArray(balance.outputSchema.anyOf));

  const deposit = listed.result.tools.find(
    (tool) => tool.name === "pot_deposit",
  );
  assert.equal(deposit.annotations.readOnlyHint, false);
  assert.equal(deposit.annotations.destructiveHint, true);
  assert.equal(deposit.annotations.idempotentHint, true);
});

test("rejects unsupported modern revisions without poisoning the connection", async (t) => {
  const server = startServer("read");
  t.after(() => server.close());

  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: modernMeta() },
  });
  const initial = await server.receive();
  assert.equal(initial.result.resultType, "complete");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {
      _meta: {
        ...modernMeta(),
        "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      },
    },
  });
  const rejected = await server.receive();
  assert.equal(rejected.error.code, -32022);
  assert.deepEqual(rejected.error.data, {
    supported: ["2026-07-28"],
    requested: "2099-01-01",
  });

  server.send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: { _meta: modernMeta() },
  });
  const recovered = await server.receive();
  assert.equal(recovered.result.resultType, "complete");
  assert.equal(recovered.result.tools.length, 8);
});

test("preserves invalid-envelope errors for malformed protocol claims", async (t) => {
  const server = startServer("read");
  t.after(() => server.close());

  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { _meta: modernMeta() },
  });
  const initial = await server.receive();
  assert.equal(initial.result.resultType, "complete");

  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {
      _meta: {
        ...modernMeta(),
        "io.modelcontextprotocol/protocolVersion": 20260728,
      },
    },
  });
  const rejected = await server.receive();
  assert.equal(rejected.error.code, -32602);
});

test("retains MCP 2025-11-25 compatibility", async (t) => {
  const server = startServer("read");
  t.after(() => server.close());

  server.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "monzo-mcp-test", version: "1.0.0" },
    },
  });
  const initialized = await server.receive();

  assert.equal(initialized.result.protocolVersion, "2025-11-25");
  assert.deepEqual(initialized.result.serverInfo, {
    name: "monzo-mcp",
    version: packageMetadata.version,
  });

  server.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  server.send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = await server.receive();

  assert.equal(listed.result.tools.length, 8);
  assert.equal(listed.result.resultType, undefined);
  assert.equal(listed.result.ttlMs, undefined);
  assert.equal(listed.result.tools[0].outputSchema.type, "object");
  assert.deepEqual(listed.result.tools[0].outputSchema.required, ["result"]);
});
