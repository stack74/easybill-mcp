/**
 * Configuration for hosted (HTTP + OAuth) mode.
 *
 * Hosted mode serves one MCP endpoint for a whole company. Each person connects
 * the easybill accounts listed in the tenant file with their own easybill login
 * (easybill's OAuth); nobody handles API keys.
 */

import { readFileSync } from "node:fs";

/**
 * easybill plans with REST API access and their request limits (easybill.de/preise).
 * PLUS and BUSINESS are the former names, still named in easybill's API docs.
 */
const PLAN_LIMITS: Record<string, number> = { PROFESSIONAL: 10, PREMIUM: 60, PLUS: 10, BUSINESS: 60 };
/** Plans without REST API access. */
const PLANS_WITHOUT_API = new Set(["FREE", "STARTER"]);

/**
 * Scopes requested from easybill, per resource the tools use. `stocks` has no
 * scope of its own in easybill's list; it travels with `position`.
 */
const RESOURCE_SCOPES = [
  "customer",
  "contact",
  "customer-group",
  "document",
  "document-payment",
  "position",
  "project",
  "time-tracking",
  "attachment",
  "text-template",
  "incoming-document",
] as const;
/** Read-only resources: no write scope exists or none is needed. */
const READ_ONLY_SCOPES = ["pdf-templates.readonly", "login.readonly"] as const;

export function defaultScopes(writes: boolean): string[] {
  const resource = RESOURCE_SCOPES.map((r) => (writes ? r : `${r}.readonly`));
  return [...resource, ...READ_ONLY_SCOPES];
}

export interface TenantConfig {
  /** Slug used as the `account` argument, e.g. "acme". */
  id: string;
  /** Shown on the connect page and to the model. */
  name: string;
  /** Allow create/update/delete tools against this account. */
  writes: boolean;
  /** Client-side throttle, shared by everyone using this account. */
  rateLimitPerMinute: number;
  /** OAuth scopes requested from easybill. */
  scopes: string[];
  /**
   * Optional check that the person logged into the right easybill account:
   * every listed access-token claim must equal (or be one of) the given value(s).
   * Without it, any easybill login is accepted for this tenant.
   */
  match?: Record<string, string | number | (string | number)[]>;
}

export interface HostedConfig {
  /** Public base URL, e.g. https://easybill-mcp.example.com. The MCP endpoint is <publicUrl>/mcp. */
  publicUrl: URL;
  mcpUrl: URL;
  host: string;
  port: number;
  /** Encrypts stored easybill tokens and signs the browser cookie. */
  secret: string;
  dbPath: string;
  tenants: TenantConfig[];
  /**
   * How people connect an easybill account:
   *  - "apikey" (default): they paste their personal easybill API key.
   *  - "oauth": they log in through easybill's OAuth. easybill only allows this
   *    for OAuth clients it has issued (dynamic registration is allowlisted).
   */
  connectMode: "apikey" | "oauth";
  upstream: {
    /** easybill's OAuth issuer; endpoints are discovered from its metadata. */
    issuer: string;
    clientId?: string;
    clientSecret?: string;
  };
  /**
   * Cloudflare Access in front of the connect pages: when set, /connect/* only
   * answers requests carrying a valid Access token for this application.
   */
  cloudflareAccess?: { issuer: string; audience: string };
  /** Lifetime of the access tokens this server issues to MCP clients. */
  accessTokenTtlSeconds: number;
  /** Lifetime of the refresh tokens this server issues to MCP clients. */
  refreshTokenTtlSeconds: number;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function fail(message: string): never {
  throw new Error(`Hosted mode configuration: ${message}`);
}

function parseTenants(raw: string, source: string): TenantConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${source} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { tenants?: unknown } | null)?.tenants;
  if (!Array.isArray(list) || list.length === 0) {
    fail(`${source} must contain a non-empty "tenants" array`);
  }

  const seen = new Set<string>();
  return list.map((entry: unknown, index): TenantConfig => {
    const t = (entry ?? {}) as Record<string, unknown>;
    const where = `${source} tenants[${index}]`;
    // Case-insensitive: "HMD" becomes "hmd", the value the model passes as `account`.
    const id = typeof t.id === "string" ? t.id.trim().toLowerCase() : "";
    if (!SLUG.test(id)) fail(`${where}.id must be a slug (letters, digits, - and _), got ${JSON.stringify(t.id)}`);
    if (seen.has(id)) fail(`${where}.id "${id}" is used twice`);
    seen.add(id);

    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim() : id;
    const writes = t.writes === true;

    let rateLimitPerMinute = 10;
    if (typeof t.rate_limit_per_minute === "number" && t.rate_limit_per_minute >= 1) {
      rateLimitPerMinute = Math.floor(t.rate_limit_per_minute);
    } else if (t.plan !== undefined) {
      const plan = String(t.plan).toUpperCase();
      if (PLANS_WITHOUT_API.has(plan)) {
        fail(`${where}: easybill's ${t.plan} plan has no REST API access — Professional or Premium is required`);
      }
      const limit = PLAN_LIMITS[plan];
      if (limit === undefined) fail(`${where}.plan must be PROFESSIONAL or PREMIUM, got ${JSON.stringify(t.plan)}`);
      rateLimitPerMinute = limit;
    }

    let scopes = defaultScopes(writes);
    if (t.scopes !== undefined) {
      if (!Array.isArray(t.scopes) || !t.scopes.every((s) => typeof s === "string")) {
        fail(`${where}.scopes must be an array of strings`);
      }
      scopes = t.scopes as string[];
    }

    let match: TenantConfig["match"];
    if (t.match !== undefined) {
      if (!t.match || typeof t.match !== "object" || Array.isArray(t.match)) {
        fail(`${where}.match must be an object of claim -> value`);
      }
      match = t.match as TenantConfig["match"];
    }

    return { id, name, writes, rateLimitPerMinute, scopes, ...(match ? { match } : {}) };
  });
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const rawUrl = env.EASYBILL_PUBLIC_URL?.trim();
  if (!rawUrl) fail("EASYBILL_PUBLIC_URL is required, e.g. https://easybill-mcp.example.com");
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl.replace(/\/+$/, ""));
  } catch {
    fail(`EASYBILL_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  // Same escape hatch the MCP SDK uses for its issuer check — for LAN tests only:
  // API keys and tokens then travel unencrypted.
  const insecureAllowed = /^(1|true)$/.test(env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL ?? "");
  if (publicUrl.protocol !== "https:" && !localhost && !insecureAllowed) {
    fail(
      "EASYBILL_PUBLIC_URL must use https (http is only allowed for localhost; for a test in a " +
        "trusted local network set MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true)",
    );
  }

  const secret = env.EASYBILL_MCP_SECRET ?? "";
  if (secret.length < 32) {
    fail("EASYBILL_MCP_SECRET must be at least 32 characters (e.g. `openssl rand -base64 48`)");
  }

  let tenants: TenantConfig[];
  if (env.EASYBILL_TENANTS?.trim()) {
    tenants = parseTenants(env.EASYBILL_TENANTS, "EASYBILL_TENANTS");
  } else if (env.EASYBILL_TENANTS_FILE?.trim()) {
    const file = env.EASYBILL_TENANTS_FILE.trim();
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      fail(`cannot read EASYBILL_TENANTS_FILE ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
    tenants = parseTenants(raw, file);
  } else {
    fail("set EASYBILL_TENANTS_FILE (path to a JSON file) or EASYBILL_TENANTS (inline JSON)");
  }

  const clientId = env.EASYBILL_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.EASYBILL_OAUTH_CLIENT_SECRET?.trim();
  const rawMode = env.EASYBILL_CONNECT_MODE?.trim().toLowerCase();
  if (rawMode && rawMode !== "apikey" && rawMode !== "oauth") {
    fail(`EASYBILL_CONNECT_MODE must be "apikey" or "oauth", got ${JSON.stringify(rawMode)}`);
  }
  const connectMode: HostedConfig["connectMode"] = (rawMode as HostedConfig["connectMode"] | "") || (clientId ? "oauth" : "apikey");

  const teamDomain = env.EASYBILL_CF_ACCESS_TEAM_DOMAIN?.trim();
  const accessAud = env.EASYBILL_CF_ACCESS_AUD?.trim();
  if (Boolean(teamDomain) !== Boolean(accessAud)) {
    fail("set both EASYBILL_CF_ACCESS_TEAM_DOMAIN and EASYBILL_CF_ACCESS_AUD, or neither");
  }
  let cloudflareAccess: HostedConfig["cloudflareAccess"];
  if (teamDomain && accessAud) {
    // Accepts "team", "team.cloudflareaccess.com" or a full URL.
    const issuer = teamDomain.includes("://")
      ? teamDomain
      : `https://${teamDomain.includes(".") ? teamDomain : `${teamDomain}.cloudflareaccess.com`}`;
    cloudflareAccess = { issuer: issuer.replace(/\/+$/, ""), audience: accessAud };
  }

  return {
    publicUrl,
    mcpUrl: new URL(`${publicUrl.href.replace(/\/+$/, "")}/mcp`),
    host: env.HOST?.trim() || "0.0.0.0",
    port: intEnv(env, "PORT", 3000),
    secret,
    dbPath: env.EASYBILL_DB_PATH?.trim() || "./data/easybill-mcp.sqlite",
    tenants,
    connectMode,
    upstream: {
      issuer: (env.EASYBILL_OAUTH_ISSUER?.trim() || "https://api.easybill.de").replace(/\/+$/, ""),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
    accessTokenTtlSeconds: intEnv(env, "EASYBILL_MCP_ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtlSeconds: intEnv(env, "EASYBILL_MCP_REFRESH_TOKEN_TTL", 90 * 24 * 3600),
  };
}
