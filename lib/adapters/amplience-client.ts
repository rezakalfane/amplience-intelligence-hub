import { sleep } from "@/lib/utils/pool";

export type ApiErrorKind = "unauthorized" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "server" | "network" | "timeout" | "bad_request";

export class AmplienceApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The only host this client ever calls (Dynamic Content Management API). */
export const MANAGEMENT_API = "https://api.amplience.net/v2/content";

export interface ClientConfig {
  /** Personal access token (or OAuth access token): sent as `Authorization: Bearer`. */
  token: string;
  base?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  baseDelayMs?: number;
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

type Query = Record<string, string | number | boolean | undefined>;

/** HAL collection page: items under `_embedded.<key>`. */
export interface HalPage<T> {
  _embedded?: Record<string, T[]>;
  page?: { size: number; totalElements: number; totalPages: number; number: number };
}

/** Thin Management API client. The token stays inside this object; error messages never include headers. */
export class AmplienceClient {
  private calls = 0;
  constructor(private readonly cfg: ClientConfig) {}

  get callCount() {
    return this.calls;
  }

  async get<T>(path: string, query: Query = {}, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, query, signal);
  }

  /** Single-attempt write (no retries: a retried PATCH could be applied twice). Only used by the guarded writer and maintenance scripts. */
  async patch<T>(path: string, body: unknown, query: Query = {}): Promise<T> {
    return this.request<T>("PATCH", path, query, undefined, body, 0);
  }

  /** Every item of a HAL collection, following pages (size max 100). */
  async all<T>(path: string, key: string, query: Query = {}, signal?: AbortSignal): Promise<T[]> {
    const out: T[] = [];
    for (let page = 0; ; page++) {
      const res = await this.get<HalPage<T>>(path, { ...query, page, size: 100 }, signal);
      out.push(...(res._embedded?.[key] ?? []));
      if (!res.page || page + 1 >= res.page.totalPages) return out;
    }
  }

  private async request<T>(method: "GET" | "PATCH", path: string, query: Query, signal?: AbortSignal, body?: unknown, retries?: number): Promise<T> {
    const url = new URL(`${this.cfg.base ?? MANAGEMENT_API}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const max = retries ?? this.cfg.maxRetries ?? 7;

    for (let attempt = 0; ; attempt++) {
      this.calls++;
      const timeout = AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response | undefined;
      let failure: AmplienceApiError | undefined;
      try {
        res = await doFetch(url, { method, headers, signal: sig, cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (err) {
        if (signal?.aborted) throw err;
        const timedOut = timeout.aborted;
        failure = new AmplienceApiError(timedOut ? "timeout" : "network", timedOut ? `Timed out calling ${path}` : `Network error calling ${path}`);
      }
      if (res?.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      if (res) {
        const payload = (await res.json().catch(() => ({}))) as { errors?: { code?: string; message?: string }[]; message?: string };
        const first = payload.errors?.[0];
        const detail = first ? `: ${[first.code, first.message].filter(Boolean).join(" ")}`.slice(0, 300) : payload.message ? `: ${payload.message}`.slice(0, 300) : "";
        failure = new AmplienceApiError(kindOf(res.status), `Amplience ${res.status} on ${path}${detail}`, res.status);
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after"));
          if (attempt < max) {
            await sleep(this.delay(attempt, retryAfter), signal);
            continue;
          }
        }
      } else if (failure && attempt < max) {
        await sleep(this.delay(attempt), signal);
        continue;
      }
      throw failure as AmplienceApiError;
    }
  }

  private delay(attempt: number, retryAfterSec?: number): number {
    if (retryAfterSec && Number.isFinite(retryAfterSec)) return Math.min(retryAfterSec * 1000, 20_000) + Math.random() * 250;
    const base = Math.min((this.cfg.baseDelayMs ?? 500) * 2 ** attempt, 20_000);
    return base / 2 + Math.random() * (base / 2); // exponential backoff with jitter
  }
}
