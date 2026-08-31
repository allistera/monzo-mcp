import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, afterEach, describe, it } from "node:test";
import { URL } from "node:url";

const testHome = await mkdtemp(join(tmpdir(), "monzo-mcp-tools-"));
process.env.HOME = testHome;
const tokenDirectory = join(testHome, ".monzo-mcp");
await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  join(tokenDirectory, "tokens.json"),
  JSON.stringify({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    client_id: "test-client-id",
    client_secret: "test-client-secret",
    redirect_uri: "http://localhost:8765/callback",
    expires_at: Date.now() + 3_600_000,
  }),
  { mode: 0o600 },
);

const { tools } = await import("../dist/tools.js");
const getBalance = tools.find((tool) => tool.name === "get_balance");
const createReceipt = tools.find((tool) => tool.name === "create_receipt");
assert.ok(getBalance);
assert.ok(createReceipt);

const originalFetch = globalThis.fetch;

after(async () => {
  globalThis.fetch = originalFetch;
  await rm(testHome, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tool handlers", () => {
  it("keeps top-level receipt identifiers authoritative", async () => {
    let requestBody;
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      assert.equal(url.pathname, "/transaction-receipts");
      assert.equal(options.method, "PUT");
      requestBody = JSON.parse(options.body);
      return new globalThis.Response(JSON.stringify({ ok: true }), {
        status: 200,
      });
    };

    await createReceipt.handler({
      external_id: "authoritative-external-id",
      transaction_id: "authoritative-transaction-id",
      receipt: {
        total: 123,
        external_id: "nested-external-id",
        transaction_id: "nested-transaction-id",
      },
    });

    assert.deepEqual(requestBody, {
      total: 123,
      external_id: "authoritative-external-id",
      transaction_id: "authoritative-transaction-id",
    });
  });

  it("resolves the current default account for each implicit operation", async () => {
    const accountIds = ["account-one", "account-two"];
    const resolvedAccounts = [];
    let accountRequestCount = 0;

    globalThis.fetch = async (input) => {
      const url = new URL(input);
      if (url.pathname === "/accounts") {
        const accountId = accountIds[accountRequestCount++];
        resolvedAccounts.push(accountId);
        return new globalThis.Response(
          JSON.stringify({
            accounts: [{ id: accountId, type: "uk_retail", closed: false }],
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/balance") {
        return new globalThis.Response(
          JSON.stringify({
            account_id: url.searchParams.get("account_id"),
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    assert.deepEqual(await getBalance.handler({}), {
      account_id: "account-one",
    });
    assert.deepEqual(await getBalance.handler({}), {
      account_id: "account-two",
    });
    assert.deepEqual(resolvedAccounts, ["account-one", "account-two"]);

    assert.deepEqual(await getBalance.handler({ account_id: "explicit" }), {
      account_id: "explicit",
    });
    assert.deepEqual(resolvedAccounts, ["account-one", "account-two"]);
  });
});
