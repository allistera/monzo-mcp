import { forceRefresh, getValidAccessToken } from "./auth.js";

const BASE_URL = "https://api.monzo.com";

export type Query = Record<string, string | number | string[] | undefined>;

function buildQuery(q?: Query): string {
  if (!q) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(k, String(item));
    } else {
      params.set(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Query;
  /** Sent as application/x-www-form-urlencoded (matching Monzo's API). */
  form?: Record<string, string | number | string[] | undefined>;
  /** Sent as application/json. */
  json?: unknown;
}

export async function monzoRequest<T = unknown>(
  opts: RequestOptions,
  retry = true,
): Promise<T> {
  const token = await getValidAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (opts.form) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const i of v) form.append(k, String(i));
      else form.set(k, String(v));
    }
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${BASE_URL}${opts.path}${buildQuery(opts.query)}`, {
    method: opts.method ?? "GET",
    headers,
    body,
  });

  if (res.status === 401 && retry) {
    await forceRefresh();
    return monzoRequest<T>(opts, false);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Monzo API ${res.status} ${res.statusText}: ${text}`);
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
