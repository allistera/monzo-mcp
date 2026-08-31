import { createServer } from "node:http";
import { exec } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fetchWithTimeout } from "./http.js";

const AUTH_URL = "https://auth.monzo.com/";
const TOKEN_URL = "https://api.monzo.com/oauth2/token";
const TOKEN_PATH = join(homedir(), ".monzo-mcp", "tokens.json");
const TOKEN_DIRECTORY = dirname(TOKEN_PATH);
const REFRESH_LOCK_PATH = join(TOKEN_DIRECTORY, ".refresh.lock");
const REFRESH_RECLAIM_GUARD_PATH = join(
  TOKEN_DIRECTORY,
  ".refresh-reclaim.guard",
);
const REFRESH_LOCK_STALE_AFTER_MS = 10_000;
const REFRESH_LOCK_WAIT_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_POLL_MS = 25;
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
  await mkdir(TOKEN_DIRECTORY, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(TOKEN_DIRECTORY, 0o700);
  }

  const temporaryPath = join(
    TOKEN_DIRECTORY,
    `.tokens-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(t, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      await chmod(temporaryPath, 0o600);
    }
    await rename(temporaryPath, TOKEN_PATH);
    if (process.platform !== "win32") {
      await chmod(TOKEN_PATH, 0o600);
    }
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
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
  return fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    },
    async (res) => {
      if (!res.ok) {
        throw new Error(`Token endpoint ${res.status}: ${await res.text()}`);
      }
      return (await res.json()) as TokenResponse;
    },
  );
}

let refreshPromise: Promise<TokenSet> | null = null;

interface RefreshLockMetadata {
  owner: string;
  pid: number;
  createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLockMetadata(
  lockPath: string,
): Promise<RefreshLockMetadata | null> {
  try {
    const metadata = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf8"),
    ) as Partial<RefreshLockMetadata>;
    const { owner, pid, createdAt } = metadata;
    if (
      typeof owner !== "string" ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof createdAt !== "number"
    ) {
      return null;
    }
    return metadata as RefreshLockMetadata;
  } catch {
    return null;
  }
}

async function readRefreshLockMetadata(): Promise<RefreshLockMetadata | null> {
  return readLockMetadata(REFRESH_LOCK_PATH);
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  let lockStats;
  try {
    lockStats = await stat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  const metadata = await readLockMetadata(lockPath);
  const createdAt = metadata?.createdAt ?? lockStats.mtimeMs;
  if (Date.now() - createdAt < REFRESH_LOCK_STALE_AFTER_MS) return false;
  return !metadata || !isProcessAlive(metadata.pid);
}

async function reclaimStalePath(
  lockPath: string,
  expectedOwner: string | undefined,
): Promise<void> {
  const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }

  const movedMetadata = await readLockMetadata(stalePath);
  if (
    (expectedOwner && movedMetadata?.owner !== expectedOwner) ||
    (!expectedOwner && movedMetadata)
  ) {
    try {
      await rename(stalePath, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return;
  }
  await rm(stalePath, { recursive: true, force: true });
}

async function releaseLock(lockPath: string, owner: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (!metadata || metadata.owner !== owner) return;

  const releasedPath = `${lockPath}.released-${owner}`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(releasedPath, { recursive: true, force: true });
}

async function releaseRefreshLock(owner: string): Promise<void> {
  await releaseLock(REFRESH_LOCK_PATH, owner);
}

async function acquireReclaimGuard(): Promise<() => Promise<void>> {
  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + REFRESH_LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(REFRESH_RECLAIM_GUARD_PATH, { mode: 0o700 });
      try {
        await writeFile(
          join(REFRESH_RECLAIM_GUARD_PATH, "owner.json"),
          JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        await rm(REFRESH_RECLAIM_GUARD_PATH, {
          recursive: true,
          force: true,
        });
        throw error;
      }
      return () => releaseLock(REFRESH_RECLAIM_GUARD_PATH, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStaleLock(REFRESH_RECLAIM_GUARD_PATH)) {
        const metadata = await readLockMetadata(REFRESH_RECLAIM_GUARD_PATH);
        await reclaimStalePath(REFRESH_RECLAIM_GUARD_PATH, metadata?.owner);
      }
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
    }
  }
  throw new Error("Timed out waiting for token refresh reclaim guard.");
}

async function reclamationInProgress(): Promise<boolean> {
  try {
    await stat(REFRESH_RECLAIM_GUARD_PATH);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function reclaimStaleRefreshLock(): Promise<void> {
  const releaseGuard = await acquireReclaimGuard();
  try {
    if (!(await isStaleLock(REFRESH_LOCK_PATH))) return;
    const metadata = await readRefreshLockMetadata();
    await reclaimStalePath(REFRESH_LOCK_PATH, metadata?.owner);
  } finally {
    await releaseGuard();
  }
}

async function acquireRefreshLock(): Promise<() => Promise<void>> {
  await mkdir(TOKEN_DIRECTORY, { recursive: true });
  if (process.platform !== "win32") {
    await chmod(TOKEN_DIRECTORY, 0o700);
  }

  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const deadline = Date.now() + REFRESH_LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reclamationInProgress()) {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
      continue;
    }
    try {
      await mkdir(REFRESH_LOCK_PATH, { mode: 0o700 });
      try {
        await writeFile(
          join(REFRESH_LOCK_PATH, "owner.json"),
          JSON.stringify({ owner, pid: process.pid, createdAt: Date.now() }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        await rm(REFRESH_LOCK_PATH, { recursive: true, force: true });
        throw error;
      }
      if (await reclamationInProgress()) {
        await releaseRefreshLock(owner);
        continue;
      }
      return () => releaseRefreshLock(owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaimStaleRefreshLock();
      await new Promise((resolve) => setTimeout(resolve, REFRESH_LOCK_POLL_MS));
    }
  }
  throw new Error("Timed out waiting for token refresh lock.");
}

async function refreshTokensOnce(t: TokenSet): Promise<TokenSet> {
  if (!t.refresh_token) {
    throw new Error(
      "Access token expired and no refresh_token available. Re-run `monzo-mcp auth`.",
    );
  }
  const releaseLock = await acquireRefreshLock();
  try {
    const current = await loadTokens();
    if (
      current &&
      (current.access_token !== t.access_token ||
        current.refresh_token !== t.refresh_token ||
        current.expires_at > t.expires_at)
    ) {
      return current;
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
  } finally {
    await releaseLock();
  }
}

export function refreshTokens(t: TokenSet): Promise<TokenSet> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const pending = refreshTokensOnce(t);
  refreshPromise = pending;
  void pending.then(
    () => {
      if (refreshPromise === pending) refreshPromise = null;
    },
    () => {
      if (refreshPromise === pending) refreshPromise = null;
    },
  );
  return pending;
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

export async function forceRefresh(
  rejectedAccessToken?: string,
): Promise<string> {
  const t = await loadTokens();
  if (!t) throw new Error("No tokens found. Run `monzo-mcp auth` first.");
  if (
    rejectedAccessToken !== undefined &&
    t.access_token !== rejectedAccessToken
  ) {
    return t.access_token;
  }
  const updated = await refreshTokens(t);
  return updated.access_token;
}
