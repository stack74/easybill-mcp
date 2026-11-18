/**
 * Hosted mode: Streamable HTTP transport + OAuth, for use as a remote connector
 * (claude.ai "Custom connector", Claude Code `--transport http`, …).
 *
 * Routes:
 *   /.well-known/*, /authorize, /token, /register, /revoke   OAuth (SDK mcpAuthRouter)
 *   /connect/...                                            connect page + easybill OAuth callback
 *   POST /mcp                                               MCP endpoint (stateless, bearer auth)
 *   GET  /healthz                                           liveness
 *   GET  /favicon.ico, /favicon.<ext>                        icon (only with EASYBILL_ICON_PATH)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { API_BASE_URL, SERVER_NAME, SERVER_VERSION, TIMEOUT_MS } from "../constants.js";
import { createEasybillServer } from "../server.js";
import { type ApiClient, EasybillClient, RateLimiter } from "../services/client.js";
import { accountInstructions, registerAccountTools } from "./accounts.js";
import { type HostedConfig, loadHostedConfig, type TenantConfig } from "./config.js";
import { renderConnectPage, renderKeyForm, renderMessage, setPageIcon } from "./pages.js";
import { GrantCookie, HostedOAuthProvider, SESSION_TTL_SECONDS } from "./provider.js";
import { type SessionRow, Store } from "./store.js";
import { ConnectionTokens, decodeJwtClaims, EasybillOAuth, pkcePair } from "./upstream.js";

/** Banner texts on the connect page, addressed by code so a crafted link cannot inject text. */
const MESSAGES: Record<string, (tenant?: TenantConfig) => string> = {
  connected: (t) => `„${t?.name ?? "Account"}“ ist verbunden.`,
  disconnected: (t) => `„${t?.name ?? "Account"}“ wurde getrennt.`,
  denied: (t) => `Die Anmeldung bei easybill für „${t?.name ?? "Account"}“ wurde abgebrochen.`,
  exchange_failed: (t) =>
    `easybill hat die Anmeldung für „${t?.name ?? "Account"}“ nicht bestätigt. Bitte versuche es erneut.`,
  wrong_account: (t) =>
    `Du hast dich bei easybill mit einem anderen Account angemeldet als „${t?.name ?? "Account"}“. ` +
    `Melde dich in easybill ab und verbinde erneut mit dem richtigen Login.`,
  duplicate_login: (t) =>
    `Dieser easybill-Login ist hier schon mit einem anderen Account verbunden – nicht mit „${t?.name ?? "Account"}“. ` +
    `Wahrscheinlich hat easybill dich automatisch mit der bestehenden Sitzung angemeldet. ` +
    `Melde dich in easybill ab und verbinde erneut.`,
  none_connected: () => "Verbinde mindestens einen Account, bevor du fortfährst.",
};

/** Far future, for API keys: they have no expiry of their own. */
const NEVER = 253402300799; // 9999-12-31

interface KeyInspection {
  /** Login IDs of the easybill account the key belongs to; empty when /logins is not readable with it. */
  loginIds: string[];
  /** "First Last" when the account has exactly one login. */
  singleLoginName?: string;
}

/**
 * Checks an API key against easybill and reads the account's login IDs, which
 * identify the account. Returns the HTTP status on rejection.
 */
async function inspectApiKey(key: string, limiter: RateLimiter): Promise<KeyInspection | { status: number }> {
  const call = async (path: string): Promise<globalThis.Response> => {
    await limiter.acquire();
    return fetch(`${API_BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}` },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 15_000)),
    });
  };
  const response = await call("/logins?limit=1000");
  if (response.ok) {
    const body = (await response.json()) as { items?: { id?: unknown; first_name?: unknown; last_name?: unknown }[] };
    const items = body.items ?? [];
    const loginIds = items.map((l) => String(l.id)).filter((id) => id !== "undefined");
    const only = items.length === 1 ? items[0] : undefined;
    const name = only ? [only.first_name, only.last_name].filter((v) => typeof v === "string" && v).join(" ") : "";
    return { loginIds, ...(name ? { singleLoginName: name } : {}) };
  }
  if (response.status === 403) {
    // A login without rights on /logins: the key may still be valid.
    const probe = await call("/customer-groups?limit=1");
    if (probe.ok) return { loginIds: [] };
    return { status: probe.status };
  }
  return { status: response.status };
}

const overlaps = (a: string[], b: string[]): boolean => a.some((id) => b.includes(id));

function matchesTenant(tenant: TenantConfig, claims: Record<string, unknown>): boolean {
  if (!tenant.match) return true;
  return Object.entries(tenant.match).every(([claim, expected]) => {
    const actual = claims[claim];
    const allowed = Array.isArray(expected) ? expected : [expected];
    return allowed.some((value) => String(value) === String(actual));
  });
}

/** Best effort: who logged in, for the connect page. Never fails the connection. */
async function loginLabel(accessToken: string, claims: Record<string, unknown>): Promise<string | null> {
  const fromClaims = [claims.email, claims.name].find((v) => typeof v === "string" && v.trim());
  const sub = claims.sub;
  if (typeof sub === "string" || typeof sub === "number") {
    try {
      const response = await fetch(`${API_BASE_URL}/logins/${encodeURIComponent(String(sub))}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
        },
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, 10_000)),
      });
      if (response.ok) {
        const login = (await response.json()) as Record<string, unknown>;
        const name = [login.first_name, login.last_name].filter((v) => typeof v === "string" && v).join(" ");
        const label = name || (typeof login.email === "string" ? login.email : "");
        if (label) return label;
      }
    } catch {
      // fall through
    }
  }
  return typeof fromClaims === "string" ? fromClaims : null;
}

export interface HostedApp {
  app: express.Express;
  store: Store;
  config: HostedConfig;
}

/** Builds the app without listening — used by start() and by tests. */
export async function createHostedApp(config: HostedConfig): Promise<HostedApp> {
  const store = new Store(config.dbPath, config.secret);
  // easybill only issues OAuth clients on request; API keys are the default.
  const oauth = config.connectMode === "oauth" ? new EasybillOAuth(config, store) : undefined;
  if (oauth) await oauth.init();
  const tokens = new ConnectionTokens(store, oauth);
  const cookie = new GrantCookie(config.secret, config.publicUrl.protocol === "https:");
  const provider = new HostedOAuthProvider(config, store, cookie);
  const tenants = config.tenants;
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  // easybill's plan limit is per account, so everyone on a tenant shares one throttle.
  const limiters = new Map(tenants.map((t) => [t.id, new RateLimiter(t.rateLimitPerMinute)]));

  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy (Coolify/Traefik): needed for the SDK's rate limiting.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  // Optional icon from outside the image. claude.ai shows the domain's favicon
  // next to a custom connector; MCP clients read the server info icon.
  let icons: Icon[] | undefined;
  if (config.icon) {
    const { path: iconPath, mimeType, extension } = config.icon;
    let body: Buffer;
    try {
      body = readFileSync(iconPath);
    } catch (error) {
      throw new Error(`Hosted mode configuration: cannot read EASYBILL_ICON_PATH ${JSON.stringify(iconPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const iconRoute = `/favicon.${extension}`;
    const sendIcon = (_req: Request, res: Response): void => {
      res.set("Cache-Control", "public, max-age=86400").type(mimeType).send(body);
    };
    app.get(iconRoute, sendIcon);
    if (iconRoute !== "/favicon.ico") app.get("/favicon.ico", sendIcon);
    setPageIcon(iconRoute, mimeType);
    icons = [{ src: new URL(iconRoute, config.publicUrl).href, mimeType, ...(extension === "svg" ? { sizes: ["any"] } : {}) }];
  }

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.mcpUrl,
      resourceName: "easybill",
    }),
  );

  // --- Cloudflare Access in front of the connect pages ----------------------
  //
  // The connect pages are opened by people in a browser, so they can sit behind
  // a Zero Trust policy. /mcp, /token, /register and /.well-known stay open:
  // claude.ai calls them from its servers. Checking the Access token here (not
  // only at Cloudflare's edge) keeps the policy effective when the origin is
  // reachable directly, e.g. by IP.

  const access = config.cloudflareAccess;
  const accessKeys = access ? createRemoteJWKSet(new URL(`${access.issuer}/cdn-cgi/access/certs`)) : undefined;

  const readAccessToken = (req: Request): string | undefined => {
    const header = req.headers["cf-access-jwt-assertion"];
    if (typeof header === "string" && header) return header;
    const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie ?? "");
    return cookie?.[1];
  };

  app.use("/connect", async (req: Request, res: Response, next: NextFunction) => {
    if (!access || !accessKeys) return next();
    const token = readAccessToken(req);
    try {
      if (!token) throw new Error("no Cloudflare Access token");
      const { payload } = await jwtVerify(token, accessKeys, { issuer: access.issuer, audience: access.audience });
      res.locals.viewer = typeof payload.email === "string" ? payload.email : String(payload.sub ?? "");
      next();
    } catch (error) {
      console.error(`Connect page refused (Cloudflare Access): ${error instanceof Error ? error.message : String(error)}`);
      res.setHeader("Cache-Control", "no-store");
      res
        .status(403)
        .type("html")
        .send(renderMessage("Kein Zugriff", "Diese Seite ist nur über die Anmeldung des Unternehmens (Cloudflare Access) erreichbar."));
    }
  });

  const viewerOf = (res: Response): string | undefined =>
    typeof res.locals.viewer === "string" && res.locals.viewer ? res.locals.viewer : undefined;

  // --- connect page --------------------------------------------------------

  const pageHeaders = (res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'");
  };

  const expired = (res: Response): void => {
    pageHeaders(res);
    res
      .status(400)
      .type("html")
      .send(
        renderMessage(
          "Link abgelaufen",
          "Diese Seite ist nicht mehr gültig. Starte die Verbindung in Claude erneut oder lass dir von Claude einen neuen Link geben (easybill_list_accounts).",
        ),
      );
  };

  const refuse = (res: Response, title: string, text: string): void => {
    pageHeaders(res);
    res.status(403).type("html").send(renderMessage(title, text));
  };

  /**
   * Is this browser allowed to act on the session? Two checks against connect
   * links that reach someone else (a forwarded manage link, a link from someone
   * who started /authorize themselves):
   *
   *  - Grant cookie: a browser that already finished a connection carries its
   *    grant. A link of a different grant is refused — whatever this person
   *    connected there would land in someone else's Claude access. authorize()
   *    reuses the cookie's grant, so a connection started in this browser always
   *    passes.
   *  - Owner (Cloudflare Access only): a grant remembers who finished its first
   *    authorization; only that person may open its links.
   */
  const allowedHere = (req: Request, res: Response, session: SessionRow): boolean => {
    const remembered = cookie.read(req);
    if (remembered && remembered !== session.grant_id && store.grantExists(remembered)) {
      console.error(`Connect page refused: ${session.kind} link of another grant than the browser's grant cookie`);
      refuse(
        res,
        "Link gehört zu einem anderen Zugang",
        "Dieser Link gehört zu einem anderen Claude-Zugang als dem, der in diesem Browser verbunden ist. " +
          "Verbinde hier nichts: Was du hier verbindest, könnte jemand anderes nutzen. " +
          "Hat dir jemand diesen Link geschickt, schließe die Seite. Ist es dein eigener Link, öffne ihn in dem Browser, " +
          "in dem du easybill mit Claude verbunden hast.",
      );
      return false;
    }
    if (access) {
      const owner = store.getGrantOwner(session.grant_id);
      const viewer = viewerOf(res)?.trim().toLowerCase();
      if (owner && viewer !== owner) {
        console.error(`Connect page refused: ${session.kind} link of a grant owned by someone else (viewer ${viewer ?? "unknown"})`);
        refuse(
          res,
          "Kein Zugriff",
          "Dieser Link gehört zum Claude-Zugang einer anderen Person. Verbinde hier nichts und schließe die Seite. " +
            "Deinen eigenen Link bekommst du von Claude in deinem eigenen Chat (easybill_list_accounts).",
        );
        return false;
      }
    }
    return true;
  };

  /** Loads the session of /connect/:sid/… and checks this browser may use it; answers the request otherwise. */
  const loadSession = (req: Request, res: Response): SessionRow | undefined => {
    const session = store.getSession(String(req.params.sid));
    if (!session) {
      expired(res);
      return undefined;
    }
    return allowedHere(req, res, session) ? session : undefined;
  };

  // --- CSRF ------------------------------------------------------------------
  //
  // Whoever has a connect link knows its session id, so a foreign page could
  // otherwise submit the connect page's forms (connect, key, disconnect, finish,
  // cancel) in the person's browser. Each browser gets a random nonce in an
  // HttpOnly cookie; the forms carry HMAC(secret, sid + nonce). A POST must carry
  // the cookie and the token that matches it.
  //
  // Someone who opens the page themselves only gets a token for their own nonce;
  // they can neither read the victim's nonce nor compute the HMAC without the
  // secret. Over https the cookie has the __Host- prefix, so a sibling subdomain
  // (same site, so SameSite does not help) cannot plant a nonce of its choosing.
  // SameSite=Lax keeps the cookie on the top-level navigation from claude.ai and
  // easybill and off cross-site POSTs.

  const secureCookies = config.publicUrl.protocol === "https:";
  const BROWSER_COOKIE = secureCookies ? "__Host-easybill_mcp_browser" : "easybill_mcp_browser";
  const BROWSER_COOKIE_MAX_AGE = 24 * 3600;
  const wellFormedNonce = (value: string | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const csrfToken = (sid: string, nonce: string): string =>
    createHmac("sha256", config.secret).update(`csrf:${sid}:${nonce}`).digest("base64url");

  const readCookie = (req: Request, name: string): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key !== name) continue;
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const sameToken = (a: string, b: string): boolean => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  /** The browser's nonce, set as cookie if it has none yet; returns the form token for the session. */
  const issueCsrf = (req: Request, res: Response, session: SessionRow): string => {
    let nonce = readCookie(req, BROWSER_COOKIE);
    if (!wellFormedNonce(nonce)) {
      nonce = randomBytes(32).toString("base64url");
      res.cookie(BROWSER_COOKIE, nonce, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: BROWSER_COOKIE_MAX_AGE * 1000,
      });
    }
    return csrfToken(session.id, nonce);
  };

  const formBody = express.urlencoded({ extended: false, limit: "4kb" });

  /** For every POST under /connect/:sid/…: the form token must match this browser's nonce cookie. */
  const requireCsrf = (req: Request, res: Response, next: NextFunction): void => {
    const nonce = readCookie(req, BROWSER_COOKIE);
    const field = typeof req.body?.csrf === "string" ? req.body.csrf : "";
    if (wellFormedNonce(nonce) && sameToken(field, csrfToken(String(req.params.sid), nonce))) return next();
    console.error(`Connect page: ${req.method} ${req.path.replace(/^\/connect\/[^/]+/, "/connect/…")} refused, CSRF token missing or wrong`);
    refuse(
      res,
      "Nicht bestätigt",
      "Diese Aktion konnte nicht bestätigt werden. Öffne die Verbindungsseite erneut (Cookies müssen erlaubt sein) " +
        "oder starte die Verbindung in Claude neu.",
    );
  };

  const backToPage = (res: Response, session: SessionRow, kind: "e" | "n", code: string, tenantId?: string): void => {
    const params = new URLSearchParams({ [kind]: code, ...(tenantId ? { t: tenantId } : {}) });
    res.redirect(303, `/connect/${encodeURIComponent(session.id)}?${params}`);
  };

  app.get("/connect/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const pending = state ? store.takeUpstreamState(state) : undefined;
    const session = pending ? store.getSession(pending.sessionId) : undefined;
    const tenant = pending ? tenantById.get(pending.tenantId) : undefined;
    if (!oauth || !pending || !session || !tenant) return expired(res);

    if (typeof req.query.error === "string" || typeof req.query.code !== "string") {
      return backToPage(res, session, "e", "denied", tenant.id);
    }

    let upstream;
    try {
      upstream = await oauth.exchangeCode(req.query.code, pending.codeVerifier);
    } catch (error) {
      console.error(`easybill code exchange failed for tenant ${tenant.id}: ${error instanceof Error ? error.message : String(error)}`);
      return backToPage(res, session, "e", "exchange_failed", tenant.id);
    }

    const claims = decodeJwtClaims(upstream.access_token);
    const { jti: _jti, ...loggable } = claims;
    console.error(`easybill login for tenant ${tenant.id}: claims ${JSON.stringify(loggable)}`);

    if (!matchesTenant(tenant, claims)) {
      return backToPage(res, session, "e", "wrong_account", tenant.id);
    }
    // The same easybill login under two tenants means easybill reused an existing
    // browser session for the wrong company — refuse rather than mislabel data.
    if (claims.sub !== undefined) {
      const clash = store
        .listConnections(session.grant_id)
        .find((c) => c.tenant_id !== tenant.id && c.claims.sub !== undefined && String(c.claims.sub) === String(claims.sub));
      if (clash) return backToPage(res, session, "e", "duplicate_login", tenant.id);
    }

    store.saveConnection({
      grant_id: session.grant_id,
      tenant_id: tenant.id,
      auth_kind: "oauth",
      ...upstream,
      login_label: await loginLabel(upstream.access_token, claims),
      claims: loggable,
      connected_at: Math.floor(Date.now() / 1000),
    });
    backToPage(res, session, "n", "connected", tenant.id);
  });

  app.get("/connect/:sid", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = typeof req.query.t === "string" ? tenantById.get(req.query.t) : undefined;
    const message = (key: unknown): string | undefined =>
      typeof key === "string" && MESSAGES[key] ? MESSAGES[key](tenant) : undefined;
    const error = message(req.query.e);
    const notice = message(req.query.n);
    const csrf = issueCsrf(req, res, session);
    // Which app asks and where the access goes: the person must see this before
    // connecting anything, the link may come from someone else.
    const client =
      session.kind === "authorize" && session.client_id && session.redirect_uri
        ? { name: store.getClient(session.client_id)?.client_name, redirectUri: session.redirect_uri }
        : undefined;
    pageHeaders(res);
    res.type("html").send(
      renderConnectPage({
        mode: config.connectMode,
        ...(viewerOf(res) ? { viewer: viewerOf(res)! } : {}),
        session,
        csrfToken: csrf,
        ...(client ? { client } : {}),
        tenants,
        connections: store.listConnections(session.grant_id),
        ...(error ? { error } : {}),
        ...(notice ? { notice } : {}),
      }),
    );
  });

  app.post("/connect/:sid/tenants/:tid/connect", formBody, requireCsrf, (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = tenantById.get(String(req.params.tid));
    if (!tenant || !oauth) return expired(res);
    const { verifier, challenge } = pkcePair();
    const state = store.createUpstreamState(session.id, tenant.id, verifier);
    res.redirect(303, oauth.authorizationUrl(state, challenge, tenant.scopes));
  });

  // --- API-key mode: paste a personal easybill API key ---------------------

  app.get("/connect/:sid/tenants/:tid/key", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = tenantById.get(String(req.params.tid));
    if (!tenant || config.connectMode !== "apikey") return expired(res);
    const csrf = issueCsrf(req, res, session);
    pageHeaders(res);
    res.type("html").send(renderKeyForm(session, tenant, csrf));
  });

  app.post("/connect/:sid/tenants/:tid/key", formBody, requireCsrf, async (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = tenantById.get(String(req.params.tid));
    if (!tenant || config.connectMode !== "apikey") return expired(res);
    const fail = (message: string): void => {
      pageHeaders(res);
      res.status(400).type("html").send(renderKeyForm(session, tenant, issueCsrf(req, res, session), message));
    };

    const key = typeof req.body?.api_key === "string" ? req.body.api_key.trim() : "";
    if (!key || key.length > 512 || /\s/.test(key)) return fail("Bitte füge den API-Key vollständig und ohne Leerzeichen ein.");

    let inspection: KeyInspection | { status: number };
    try {
      inspection = await inspectApiKey(key, limiters.get(tenant.id)!);
    } catch (error) {
      console.error(`API key check for tenant ${tenant.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return fail("easybill ist gerade nicht erreichbar. Versuch es gleich noch einmal.");
    }
    if ("status" in inspection) {
      if (inspection.status === 401 || inspection.status === 403) {
        return fail(`easybill hat diesen API-Key nicht akzeptiert. Prüfe, ob er vollständig kopiert ist und aus „${tenant.name}“ stammt.`);
      }
      if (inspection.status === 429) return fail("easybill drosselt gerade die Anfragen. Versuch es in einer Minute noch einmal.");
      return fail(`easybill hat mit HTTP ${inspection.status} geantwortet. Versuch es gleich noch einmal.`);
    }

    // An API key does not say which account it belongs to; the login IDs do.
    const { loginIds } = inspection;
    if (loginIds.length > 0) {
      for (const [otherId, fingerprint] of store.listTenantFingerprints()) {
        if (otherId !== tenant.id && tenantById.has(otherId) && overlaps(fingerprint, loginIds)) {
          return fail(`Dieser API-Key gehört zu „${tenantById.get(otherId)!.name}“, nicht zu „${tenant.name}“.`);
        }
      }
      const known = store.getTenantFingerprint(tenant.id);
      if (known && !overlaps(known, loginIds)) {
        return fail(`Dieser API-Key gehört zu einem anderen easybill-Account als „${tenant.name}“.`);
      }
      if (!known) console.error(`Tenant ${tenant.id}: first connection, pinned to ${loginIds.length} easybill login(s)`);
      // Same account confirmed (or first connection): remember logins added since.
      store.setTenantFingerprint(tenant.id, [...(known ?? []), ...loginIds]);
    } else {
      console.error(`Tenant ${tenant.id}: key accepted, but /logins is not readable with it — account not verified`);
    }

    console.error(`Tenant ${tenant.id}: API key connected${viewerOf(res) ? ` by ${viewerOf(res)}` : ""}`);
    const suffix = `Key …${key.slice(-4)}`;
    store.saveConnection({
      grant_id: session.grant_id,
      tenant_id: tenant.id,
      auth_kind: "apikey",
      access_token: key,
      refresh_token: "",
      access_expires_at: NEVER,
      refresh_expires_at: NEVER,
      login_label: inspection.singleLoginName ? `${inspection.singleLoginName} · ${suffix}` : suffix,
      claims: { login_count: loginIds.length, ...(viewerOf(res) ? { connected_by: viewerOf(res) } : {}) },
      connected_at: Math.floor(Date.now() / 1000),
    });
    backToPage(res, session, "n", "connected", tenant.id);
  });

  app.post("/connect/:sid/tenants/:tid/disconnect", formBody, requireCsrf, (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenantId = String(req.params.tid);
    store.deleteConnection(session.grant_id, tenantId);
    backToPage(res, session, "n", "disconnected", tenantId);
  });

  app.post("/connect/:sid/finish", formBody, requireCsrf, (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.kind === "manage") {
      store.deleteSession(session.id);
      pageHeaders(res);
      res
        .type("html")
        .send(renderMessage("Fertig", "Du kannst dieses Fenster schließen und in Claude weitermachen."));
      return;
    }
    const usable = store
      .listConnections(session.grant_id)
      .filter((c) => !c.broken_reason && tenantById.has(c.tenant_id));
    if (usable.length === 0) return backToPage(res, session, "e", "none_connected");
    // Behind Cloudflare Access the grant belongs to whoever finished its first
    // authorization; its connect links then only open for them. Never from a
    // manage link (handled above): that link may have been forwarded.
    const viewer = viewerOf(res);
    if (access && viewer) store.claimGrantOwner(session.grant_id, viewer);
    cookie.write(res, session.grant_id);
    res.redirect(303, provider.completeAuthorization(session));
  });

  app.post("/connect/:sid/cancel", formBody, requireCsrf, (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.kind !== "authorize") return expired(res);
    res.redirect(303, provider.denyAuthorization(session));
  });

  // --- MCP endpoint ---------------------------------------------------------

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });

  app.post("/mcp", bearer, express.json({ limit: "25mb" }), async (req, res) => {
    const grantId = String(req.auth?.extra?.grantId ?? "");
    const connections = store.listConnections(grantId).filter((c) => tenantById.has(c.tenant_id));
    const usable = connections.filter((c) => !c.broken_reason);

    // One client per connected account; the tools get a router that picks the
    // client of the account named in the current call.
    const clients = new Map(
      usable.map((c) => [
        c.tenant_id,
        new EasybillClient(({ forceRefresh }) => tokens.accessToken(grantId, c.tenant_id, forceRefresh), {
          limiter: limiters.get(c.tenant_id)!,
        }),
      ]),
    );
    const current = new AsyncLocalStorage<EasybillClient>();
    const pick = (): EasybillClient => {
      const client = current.getStore();
      if (!client) throw new Error("No easybill account selected for this call.");
      return client;
    };
    const router: ApiClient = {
      request: (path, options) => pick().request(path, options),
      requestBinary: (path, options) => pick().requestBinary(path, options),
    };

    const accountList = usable.map((c) => {
      const tenant = tenantById.get(c.tenant_id)!;
      return { id: tenant.id, name: tenant.name, writes: tenant.writes };
    });

    const { server } = createEasybillServer(router, {
      ...(icons ? { icons } : {}),
      writesEnabled: accountList.some((a) => a.writes),
      accounts: {
        list: accountList,
        run: (accountId, fn) => current.run(clients.get(accountId)!, fn),
      },
      extraInstructions: accountInstructions(tenants, connections),
      extraTools: (s) =>
        registerAccountTools(s, {
          tenants,
          connections,
          manageLink: () => {
            const sid = store.createSession(
              {
                kind: "manage",
                grant_id: grantId,
                client_id: null,
                redirect_uri: null,
                code_challenge: null,
                state: null,
                resource: null,
              },
              SESSION_TTL_SECONDS,
            );
            return `${config.publicUrl.href.replace(/\/+$/, "")}/connect/${sid}`;
          },
        }),
    });

    // Stateless: a fresh server + transport per request, closed with the response.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(
        renderMessage(
          "easybill MCP",
          `Dieser Server stellt easybill als MCP-Connector bereit. Connector-URL: ${config.mcpUrl.href}`,
        ),
      );
  });

  return { app, store, config };
}

/** Entry point for `easybill-mcp --http`. */
export async function startHttpServer(): Promise<void> {
  const config = loadHostedConfig();
  const { app, store } = await createHostedApp(config);

  const purge = setInterval(() => store.purgeExpired(), 10 * 60 * 1000);
  purge.unref();

  const server = app.listen(config.port, config.host, (error?: Error) => {
    // Express 5 reports listen failures (e.g. EADDRINUSE) here, not as a throw.
    if (error) {
      console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
      process.exit(1);
    }
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} listening on ${config.host}:${config.port} | ` +
        `MCP endpoint ${config.mcpUrl.href} | connect via ${config.connectMode}` +
        `${config.cloudflareAccess ? ` | /connect behind Cloudflare Access (${config.cloudflareAccess.issuer})` : ""}` +
        ` | ${config.tenants.length} tenant(s): ` +
        config.tenants.map((t) => `${t.id}${t.writes ? " (rw)" : " (ro)"}`).join(", "),
    );
  });

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
