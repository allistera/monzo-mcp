import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import {
  createOAuthCallbackListener,
  parseOAuthRedirectUri,
} from "../dist/auth.js";

const openServers = new Set();

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
