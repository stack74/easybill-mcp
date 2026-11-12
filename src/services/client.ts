/**
 * HTTP client for the easybill REST API.
 *
 * Responsibilities:
 *  - Bearer authentication — a static API key (stdio mode) or an OAuth access
 *    token supplied per call by a token source (hosted mode)
 *  - Proactive client-side throttling (easybill allows only 10-60 req/min)
 *  - Retry with backoff on 429 / 5xx / network blips, honouring Retry-After
 *  - Mapping HTTP failures onto actionable error messages
 */

import {
  API_BASE_URL,
  MAX_RETRIES,
  RATE_LIMIT_PER_MINUTE,
  SERVER_NAME,
  SERVER_VERSION,
  TIMEOUT_MS,
} from "../constants.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Query parameter values we know how to serialise. */
export type QueryValue = string | number | boolean | null | undefined | (string | number)[];
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  method?: HttpMethod;
  /** JSON request body. */
  body?: unknown;
  query?: QueryParams;
  /** Overrides the default `application/json` Accept header. */
  accept?: string;
  /** Extra headers, e.g. a multipart Content-Type. */
  headers?: Record<string, string>;
  /** Send `body` verbatim instead of JSON-encoding it (used for file uploads). */
  rawBody?: RequestPayload;
}

/** What we ever pass as a fetch body. `BodyInit` is not global in @types/node. */
type RequestPayload = string | Uint8Array;

/** An easybill API error carrying enough context for an actionable message. */
export class EasybillApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    readonly detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`easybill API ${status} ${statusText} on ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "EasybillApiError";
  }
}

/** Binary payload returned by the PDF / attachment download endpoints. */
export interface BinaryResponse {
  data: Buffer;
  contentType: string;
  fileName?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window throttle. Keeps at most RATE_LIMIT_PER_MINUTE request
 * timestamps and waits for the oldest to age out before issuing the next call.
 * Serialised through a promise chain so concurrent tool calls queue in order.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly perMinute: number) {}

  /** Resolves once the caller is allowed to send a request. */
  acquire(): Promise<void> {
    const wait = this.queue.then(() => this.reserve());
    // Swallow rejections so one failure cannot poison the chain.
    this.queue = wait.catch(() => undefined);
    return wait;
  }

  private async reserve(): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const now = Date.now();
      while (this.timestamps.length > 0 && now - this.timestamps[0]! >= windowMs) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.perMinute) {
        this.timestamps.push(now);
        return;
      }
      // +50ms guards against waking a hair too early due to timer rounding.
      await sleep(windowMs - (now - this.timestamps[0]!) + 50);
    }
  }
}

/** Serialises a query object into URLSearchParams, dropping empty values. */
function buildQuery(query: QueryParams | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    // easybill accepts repeated filter values comma-separated.
    params.append(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Pulls a human-readable message out of an easybill error body. */
function extractDetail(raw: string): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const message = obj.message ?? obj.error ?? obj.detail;
      const parts: string[] = [];
      if (typeof message === "string") parts.push(message);
      // Validation failures arrive as { errors: { field: [msg, ...] } }.
      if (obj.errors && typeof obj.errors === "object") {
        for (const [field, msgs] of Object.entries(obj.errors as Record<string, unknown>)) {
          const text = Array.isArray(msgs) ? msgs.join("; ") : String(msgs);
          parts.push(`${field}: ${text}`);
        }
      }
      if (parts.length > 0) return parts.join(" | ");
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return raw.slice(0, 500);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isNaN(seconds) ? undefined : seconds;
}

function fileNameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) return decodeURIComponent(utf8[1].trim());
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim();
}

/**
 * What the tool modules need from a client. Lets hosted mode hand the tools a
 * router that picks the per-account client at call time.
 */
export interface ApiClient {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  requestBinary(path: string, options?: RequestOptions): Promise<BinaryResponse>;
}

/**
 * Supplies the bearer credential for each request. `forceRefresh` is set after
 * easybill answered 401, so an OAuth source can refresh an access token that
 * expired or was revoked early.
 */
export type TokenSource = (options: { forceRefresh: boolean }) => Promise<string>;

export interface ClientOptions {
  /**
   * Throttle to use. Pass a shared instance when several clients talk to the
   * same easybill account — the plan limit is per account, not per client.
   */
  limiter?: RateLimiter;
}

export class EasybillClient implements ApiClient {
  private readonly limiter: RateLimiter;
  private readonly tokenSource: TokenSource;
  private readonly canRefresh: boolean;

  constructor(auth: string | TokenSource, options: ClientOptions = {}) {
    this.limiter = options.limiter ?? new RateLimiter(RATE_LIMIT_PER_MINUTE);
    if (typeof auth === "string") {
      this.tokenSource = async () => auth;
      this.canRefresh = false;
    } else {
      this.tokenSource = auth;
      this.canRefresh = true;
    }
  }

  /** Performs a JSON request and returns the decoded body (undefined for 204). */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A few endpoints answer with a bare string.
      return text as unknown as T;
    }
  }

  /** Performs a request expecting a binary body (PDF, JPG, attachment content). */
  async requestBinary(path: string, options: RequestOptions = {}): Promise<BinaryResponse> {
    const response = await this.send(path, options);
    const buffer = Buffer.from(await response.arrayBuffer());
    const result: BinaryResponse = {
      data: buffer,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
    const fileName = fileNameFromDisposition(response.headers.get("content-disposition"));
    if (fileName !== undefined) result.fileName = fileName;
    return result;
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const { method = "GET", body, query, accept = "application/json", headers = {} } = options;
    const url = `${API_BASE_URL}${path}${buildQuery(query)}`;

    let lastError: unknown;
    let refreshed = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const token = await this.tokenSource({ forceRefresh: refreshed });
      await this.limiter.acquire();

      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        ...headers,
      };

      let payload: RequestPayload | undefined;
      if (options.rawBody !== undefined) {
        payload = options.rawBody;
      } else if (body !== undefined) {
        payload = JSON.stringify(body);
        requestHeaders["Content-Type"] = "application/json";
      }

      try {
        const response = await fetch(url, {
          method,
          headers: requestHeaders,
          ...(payload === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (response.ok) return response;

        // An OAuth access token can be revoked or expire between our expiry check
        // and the request. One forced refresh, then give up.
        if (response.status === 401 && this.canRefresh && !refreshed) {
          refreshed = true;
          await response.body?.cancel();
          attempt--; // the refresh retry does not count against MAX_RETRIES
          continue;
        }

        const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
        const retriable = response.status === 429 || response.status >= 500;

        if (retriable && attempt < MAX_RETRIES) {
          // Honour Retry-After when present, otherwise exponential backoff.
          const backoffMs = retryAfter !== undefined ? retryAfter * 1000 : 2 ** attempt * 1500;
          await sleep(Math.min(backoffMs, 60_000));
          continue;
        }

        const detail = extractDetail(await response.text());
        throw new EasybillApiError(
          response.status,
          response.statusText,
          path,
          detail,
          retryAfter,
        );
      } catch (error) {
        if (error instanceof EasybillApiError) throw error;
        lastError = error;
        // Timeouts and connection resets are worth one more shot.
        if (attempt < MAX_RETRIES) {
          await sleep(2 ** attempt * 1000);
          continue;
        }
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    if (lastError instanceof Error && lastError.name === "TimeoutError") {
      throw new Error(
        `Request to ${path} timed out after ${TIMEOUT_MS}ms. ` +
          `Retry, or narrow the request with filters / a smaller 'limit'.`,
      );
    }
    throw new Error(`Request to ${path} failed: ${reason}`);
  }
}

/**
 * Turns any thrown error into a message that tells the agent what to do next.
 */
export function formatApiError(error: unknown): string {
  if (error instanceof EasybillApiError) {
    const { status, path, detail } = error;
    const suffix = detail ? ` Details: ${detail}` : "";
    switch (status) {
      case 400:
        return `Error: easybill rejected the request as invalid (400) on ${path}.${suffix} Check required fields and that dates use YYYY-MM-DD.`;
      case 401:
        return (
          `Error: authentication failed (401).${suffix} ` +
          `With a local install, verify EASYBILL_API_KEY is a valid easybill API key (easybill: Einstellungen -> App-Center -> API). ` +
          `With the hosted server, reconnect the easybill account — easybill_list_accounts returns the link.`
        );
      case 403:
        return `Error: access denied (403) on ${path}. Your easybill plan or API key may not include this resource.${suffix}`;
      case 404:
        return `Error: not found (404) on ${path}. Verify the ID exists — list the resource first to get valid IDs.${suffix}`;
      case 406:
        return (
          `Error: this format is not available (406) on ${path}.${suffix} ` +
          `A document only exists in the e-invoice formats it was finalised with (set by the customer's ` +
          `'document_pdf_type' and the plan). Download it as 'pdf', or check the document's versions.`
        );
      case 409:
        return `Error: conflict (409) on ${path}.${suffix} The record may already be completed, cancelled, or referenced elsewhere.`;
      case 414:
        return `Error: request URI too long (414). easybill caps the request line at 4094 bytes — pass fewer filter values per call.`;
      case 422:
        return `Error: validation failed (422) on ${path}.${suffix}`;
      case 429: {
        const wait = error.retryAfterSeconds
          ? ` Retry in ${error.retryAfterSeconds}s.`
          : " Wait about a minute before retrying.";
        return (
          `Error: easybill rate limit exceeded (429).${wait} ` +
          `The plan limit is 10 req/min (Professional) or 60 req/min (Premium). ` +
          `Set EASYBILL_RATE_LIMIT_PER_MINUTE to match your plan so the server throttles itself.`
        );
      }
      default:
        if (status >= 500) {
          return `Error: easybill server error (${status}) on ${path}. This is on easybill's side — retry shortly.${suffix}`;
        }
        return `Error: easybill API returned ${status} on ${path}.${suffix}`;
    }
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: unexpected failure: ${String(error)}`;
}
