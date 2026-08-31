import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
const testHome = await mkdtemp(join(tmpdir(), "monzo-mcp-auth-"));
process.env.HOME = testHome;

const {
  createOAuthCallbackListener,
  forceRefresh,
  getValidAccessToken,
  parseOAuthRedirectUri,
  refreshTokens,
} = await import("../dist/auth.js");

const openServers = new Set();
const tokenDirectory = join(testHome, ".monzo-mcp");
const tokenPath = join(tokenDirectory, "tokens.json");
const requestLogPath = join(testHome, "refresh-requests.log");
const authModuleUrl = new URL("../dist/auth.js", import.meta.url).href;

after(async () => {
  await rm(testHome, { recursive: true, force: true });
});

afterEach(() => {
  for (const server of openServers) {
    if (server.listening) server.close();
  }
  openServers.clear();
});

async function listen(listener) {
  openServers.add(listener.server);
  listener.server.listen(listener.port, listener.host);
  await once(listener.server, "listening");
  const address = listener.server.address();
  assert.ok(address && typeof address !== "string");
  return address;
}

function runRefreshChild(method) {
  const childScript = `
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

globalThis.fetch = async () => {
  await appendFile(process.env.MONZO_REQUEST_LOG, "request\\n");
  await delay(100);
  return new globalThis.Response(JSON.stringify({
    access_token: "process-rotated-access-token",
    refresh_token: "process-rotated-refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
  }), { status: 200 });
};

const auth = await import(${JSON.stringify(authModuleUrl)});
process.stdout.write(await auth.${method}());
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childScript],
      {
        env: {
          ...process.env,
          HOME: testHome,
          MONZO_REQUEST_LOG: requestLogPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Child exited ${code ?? signal}: ${stderr}`));
      }
    });
  });
}

describe("OAuth redirect URI validation", () => {
  it("normalizes supported loopback redirect hosts", () => {
    assert.deepEqual(parseOAuthRedirectUri("http://localhost:8765/callback"), {
      host: "127.0.0.1",
      port: 8765,
      expectedPath: "/callback",
    });
    assert.deepEqual(parseOAuthRedirectUri("http://[::1]:8765/callback"), {
      host: "::1",
      port: 8765,
      expectedPath: "/callback",
    });
  });

  it("rejects non-loopback and non-HTTP redirect URIs", () => {
    assert.throws(
      () => parseOAuthRedirectUri("http://0.0.0.0:8765/callback"),
      /loopback host/,
    );
    assert.throws(
      () => parseOAuthRedirectUri("http://example.com:8765/callback"),
      /loopback host/,
    );
    assert.throws(
      () => parseOAuthRedirectUri("https://localhost:8765/callback"),
      /must use http/,
    );
  });
});

describe("OAuth callback listener", () => {
  it("ignores unauthenticated errors and still accepts the valid callback", async () => {
    const state = "expected-state";
    const listener = createOAuthCallbackListener(
      "http://127.0.0.1:0/callback",
      state,
      10_000,
    );
    const address = await listen(listener);
    assert.equal(address.address, "127.0.0.1");

    const invalid = await globalThis.fetch(
      `http://127.0.0.1:${address.port}/callback?error=attacker`,
    );
    assert.equal(invalid.status, 400);
    assert.equal(await invalid.text(), "Invalid state");
    assert.equal(listener.server.listening, true);

    const closed = once(listener.server, "close");
    const valid = await globalThis.fetch(
      `http://127.0.0.1:${address.port}/callback?state=${state}&code=valid-code`,
    );
    assert.equal(valid.status, 200);
    await valid.text();
    assert.equal(await listener.code, "valid-code");
    await closed;
    assert.equal(listener.server.listening, false);
  });

  it("preserves a state-authenticated OAuth error", async () => {
    const state = "expected-state";
    const listener = createOAuthCallbackListener(
      "http://127.0.0.1:0/callback",
      state,
      10_000,
    );
    const address = await listen(listener);
    const closed = once(listener.server, "close");
    const rejected = assert.rejects(
      listener.code,
      /OAuth error: access_denied/,
    );

    const response = await globalThis.fetch(
      `http://127.0.0.1:${address.port}/callback?state=${state}&error=access_denied`,
    );
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "OAuth authorization failed");
    await rejected;
    await closed;
  });
});

describe("token persistence and refresh coordination", () => {
  const tokenSet = {
    access_token: "old-access-token",
    refresh_token: "refresh-token",
    client_id: "client-id",
    client_secret: "client-secret",
    redirect_uri: "http://localhost:8765/callback",
    expires_at: Date.now() - 1,
  };

  afterEach(async () => {
    await rm(tokenDirectory, { recursive: true, force: true });
  });

  it("repairs permissions on an existing token file", async () => {
    await mkdir(tokenDirectory, { recursive: true, mode: 0o755 });
    await writeFile(tokenPath, JSON.stringify(tokenSet), { mode: 0o644 });
    await chmod(tokenPath, 0o644);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new globalThis.Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    try {
      await refreshTokens(tokenSet);
    } finally {
      globalThis.fetch = originalFetch;
    }

    if (process.platform !== "win32") {
      assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
      assert.equal((await stat(tokenDirectory)).mode & 0o777, 0o700);
    }
    const saved = JSON.parse(await readFile(tokenPath, "utf8"));
    assert.equal(saved.access_token, "new-access-token");
    assert.deepEqual(await readdir(tokenDirectory), ["tokens.json"]);
  });

  it("shares one refresh request between simultaneous callers", async () => {
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, JSON.stringify(tokenSet), { mode: 0o600 });

    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requestCount += 1;
      await delay(25);
      return new globalThis.Response(
        JSON.stringify({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    };
    try {
      const tokens = await Promise.all([getValidAccessToken(), forceRefresh()]);
      assert.deepEqual(tokens, [
        "rotated-access-token",
        "rotated-access-token",
      ]);
      assert.equal(requestCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const saved = JSON.parse(await readFile(tokenPath, "utf8"));
    assert.equal(saved.refresh_token, "rotated-refresh-token");
  });

  it("shares one refresh request between processes", async () => {
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, JSON.stringify(tokenSet), { mode: 0o600 });
    await writeFile(requestLogPath, "");

    const tokens = await Promise.all([
      runRefreshChild("getValidAccessToken"),
      runRefreshChild("forceRefresh"),
    ]);
    assert.deepEqual(tokens, [
      "process-rotated-access-token",
      "process-rotated-access-token",
    ]);
    assert.equal(
      (await readFile(requestLogPath, "utf8")).trim().split("\n").length,
      1,
    );
  });

  it("does not refresh when a delayed 401 has an old access token", async () => {
    await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      tokenPath,
      JSON.stringify({
        ...tokenSet,
        access_token: "already-rotated-access-token",
        refresh_token: "already-rotated-refresh-token",
        expires_at: Date.now() + 3_600_000,
      }),
      { mode: 0o600 },
    );

    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      requestCount += 1;
      return new globalThis.Response(
        JSON.stringify({
          access_token: "unexpected-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    };
    try {
      assert.equal(
        await forceRefresh("stale-rejected-access-token"),
        "already-rotated-access-token",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(requestCount, 0);
  });
});
