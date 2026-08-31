import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { HttpTimeoutError, fetchWithTimeout } = await import("../dist/http.js");

describe("fetchWithTimeout", () => {
  it("aborts a request whose response does not arrive before the deadline", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new globalThis.DOMException("aborted", "AbortError")),
          { once: true },
        );
      });

    try {
      await assert.rejects(
        fetchWithTimeout(
          "https://example.test/slow",
          {},
          async (response) => response.text(),
          10,
        ),
        (error) => {
          assert.ok(error instanceof HttpTimeoutError);
          assert.match(error.message, /timed out after 10ms/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps successful responses unchanged", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new globalThis.Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    try {
      const result = await fetchWithTimeout(
        "https://example.test/ok",
        {},
        async (response) => JSON.parse(await response.text()),
        100,
      );
      assert.deepEqual(result, { ok: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("also aborts while consuming a response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) =>
      new globalThis.Response(
        new globalThis.ReadableStream({
          start(controller) {
            init.signal.addEventListener(
              "abort",
              () =>
                controller.error(
                  new globalThis.DOMException("aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        }),
      );

    try {
      await assert.rejects(
        fetchWithTimeout(
          "https://example.test/slow-body",
          {},
          async (response) => response.text(),
          10,
        ),
        (error) => {
          assert.ok(error instanceof HttpTimeoutError);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
