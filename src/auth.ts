import { createServer } from "node:http";
import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const AUTH_URL = "https://auth.monzo.com/";
const TOKEN_URL = "https://api.monzo.com/oauth2/token";
const TOKEN_PATH = join(homedir(), ".monzo-mcp", "tokens.json");
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  expires_at: number; // epoch ms
}

export async function loadTokens(): Promise<TokenSet | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    return JSON.parse(raw) as TokenSet;
  } catch {
    return null;
  }
}

async function saveTokens(t: TokenSet): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function exchange(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token endpoint ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(t: TokenSet): Promise<TokenSet> {
  if (!t.refresh_token) {
    throw new Error(
      "Access token expired and no refresh_token available. Re-run `monzo-mcp auth`.",
    );
  }
  const resp = await exchange({
    grant_type: "refresh_token",
    client_id: t.client_id,
    client_secret: t.client_secret,
    refresh_token: t.refresh_token,
  });
  const updated: TokenSet = {
    ...t,
    access_token: resp.access_token,
    refresh_token: resp.refresh_token ?? t.refresh_token,
    expires_at: Date.now() + resp.expires_in * 1000,
  };
  await saveTokens(updated);
  return updated;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

export interface OAuthRedirectTarget {
  host: string;
  port: number;
  expectedPath: string;
}

export function parseOAuthRedirectUri(
  redirectUri: string,
): OAuthRedirectTarget {
  const url = new URL(redirectUri);
  if (url.protocol !== "http:") {
    throw new Error("MONZO_REDIRECT_URI must use http");
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      "MONZO_REDIRECT_URI must not contain credentials or a fragment",
    );
  }

  const host =
    url.hostname === "localhost"
      ? "127.0.0.1"
      : url.hostname === "[::1]"
        ? "::1"
        : url.hostname;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("MONZO_REDIRECT_URI must use a loopback host");
  }

  return {
    host,
    port: Number(url.port || 80),
    expectedPath: url.pathname,
  };
}

export interface OAuthCallbackListener {
  server: ReturnType<typeof createServer>;
  host: string;
  port: number;
  code: Promise<string>;
}

export function createOAuthCallbackListener(
  redirectUri: string,
  state: string,
  timeoutMs = OAUTH_CALLBACK_TIMEOUT_MS,
): OAuthCallbackListener {
  const { host, port, expectedPath } = parseOAuthRedirectUri(redirectUri);
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  let settled = false;

  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    const reqUrl = new URL(req.url, redirectUri);
    if (reqUrl.pathname !== expectedPath) {
      res.writeHead(404).end();
      return;
    }

    const returnedState = reqUrl.searchParams.get("state");
    if (returnedState !== state) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid state");
      return;
    }

    const error = reqUrl.searchParams.get("error");
    if (error) {
      res
        .writeHead(400, { "Content-Type": "text/plain" })
        .end("OAuth authorization failed");
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        server.close();
        rejectCode(new Error(`OAuth error: ${error}`));
      }
      return;
    }

    const returnedCode = reqUrl.searchParams.get("code");
    if (!returnedCode) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing code");
      return;
    }

    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        "<html><body><h2>Monzo auth received.</h2><p>Approve the request in your Monzo app, then return to the terminal.</p></body></html>",
      );
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      server.close();
      resolveCode(returnedCode);
    }
  });

  server.on("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectCode(error);
    }
  });

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      server.close();
      rejectCode(new Error("OAuth callback timed out"));
    }
  }, timeoutMs);
  timeout.unref();

  return { server, host, port, code };
}

export async function runAuthFlow(): Promise<void> {
  const client_id = process.env.MONZO_CLIENT_ID;
  const client_secret = process.env.MONZO_CLIENT_SECRET;
  const redirect_uri =
    process.env.MONZO_REDIRECT_URI ?? "http://localhost:8765/callback";

  if (!client_id || !client_secret) {
    throw new Error(
      "Set MONZO_CLIENT_ID and MONZO_CLIENT_SECRET. Register a confidential client at https://developers.monzo.com/ with redirect URI " +
        redirect_uri,
    );
  }

  const state = randomBytes(16).toString("hex");

  const authorizeUrl = new URL(AUTH_URL);
  authorizeUrl.searchParams.set("client_id", client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirect_uri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);

  const callback = createOAuthCallbackListener(redirect_uri, state);
  callback.server.listen(callback.port, callback.host, () => {
    process.stderr.write(
      `Listening on ${redirect_uri}\nOpen this URL to authorise:\n${authorizeUrl.toString()}\n`,
    );
    openBrowser(authorizeUrl.toString());
  });
  const code = await callback.code;

  const resp = await exchange({
    grant_type: "authorization_code",
    client_id,
    client_secret,
    redirect_uri,
    code,
  });

  const tokens: TokenSet = {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    client_id,
    client_secret,
    redirect_uri,
    expires_at: Date.now() + resp.expires_in * 1000,
  };
  await saveTokens(tokens);
  process.stderr.write(
    `Saved tokens to ${TOKEN_PATH}.\nApprove the access request in your Monzo app to complete Strong Customer Authentication.\n`,
  );
}

export async function getValidAccessToken(): Promise<string> {
  let t = await loadTokens();
  if (!t) {
    throw new Error("No tokens found. Run `monzo-mcp auth` first.");
  }
  // Refresh 60s before expiry.
  if (Date.now() >= t.expires_at - 60_000) {
    t = await refreshTokens(t);
  }
  return t.access_token;
}

export async function forceRefresh(): Promise<string> {
  const t = await loadTokens();
  if (!t) throw new Error("No tokens found. Run `monzo-mcp auth` first.");
  const updated = await refreshTokens(t);
  return updated.access_token;
}
