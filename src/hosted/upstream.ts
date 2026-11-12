/**
 * OAuth client towards easybill (the "upstream").
 *
 * easybill runs an OAuth 2.0 authorization server at api.easybill.de with
 * dynamic client registration, PKCE (S256) and refresh tokens. Its access tokens
 * are JWTs that the REST API accepts as `Authorization: Bearer …`.
 * Documented at https://api.easybill.de/rest/v1/OAUTH2.md; endpoints are read
 * from the issuer's /.well-known/oauth-authorization-server.
 *
 * Lifetimes per easybill's docs: access token 1 hour, refresh token 1 month.
 */

import { createHash, randomBytes } from "node:crypto";
import { SERVER_NAME, SERVER_VERSION, TIMEOUT_MS } from "../constants.js";
import type { HostedConfig } from "./config.js";
import type { Store } from "./store.js";

/** easybill documents a one-month refresh token lifetime; we cannot read it from the response. */
const UPSTREAM_REFRESH_TTL_SECONDS = 30 * 24 * 3600;

export interface UpstreamTokens {
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
}

/** An error from easybill's OAuth endpoints. `permanent` means: the person has to reconnect. */
export class UpstreamOAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "UpstreamOAuthError";
  }
}

/** The connection is gone for good; tool calls should tell the model to get a reconnect link. */
export class ReconnectRequiredError extends Error {
  constructor(readonly tenantId: string, reason: string) {
    super(
      `The connection to the easybill account '${tenantId}' is no longer valid (${reason}). ` +
        `Call easybill_list_accounts and give the user the link to reconnect it.`,
    );
    this.name = "ReconnectRequiredError";
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Reads a JWT's claims without verifying it — only for tokens we just got from easybill over TLS. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

const userAgent = `${SERVER_NAME}/${SERVER_VERSION}`;

export class EasybillOAuth {
  readonly redirectUri: string;
  private metadata?: Metadata;
  private clientId?: string;
  private clientSecret?: string;

  constructor(
    private readonly config: HostedConfig,
    private readonly store: Store,
  ) {
    this.redirectUri = `${config.publicUrl.href.replace(/\/+$/, "")}/connect/callback`;
  }

  /** Discovers easybill's endpoints and makes sure we have a client registration. */
  async init(): Promise<void> {
    const { issuer } = this.config.upstream;
    const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`easybill OAuth metadata at ${issuer} answered ${response.status}`);
    }
    const metadata = (await response.json()) as Partial<Metadata>;
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error(`easybill OAuth metadata at ${issuer} lacks authorization/token endpoints`);
    }
    this.metadata = metadata as Metadata;
    await this.ensureClient();
  }

  private get endpoints(): Metadata {
    if (!this.metadata) throw new Error("EasybillOAuth.init() has not run");
    return this.metadata;
  }

  private async ensureClient(): Promise<void> {
    const { clientId, clientSecret } = this.config.upstream;
    if (clientId) {
      this.clientId = clientId;
      if (clientSecret) this.clientSecret = clientSecret;
      return;
    }

    // Registered earlier for this redirect URI? Re-registering on every start
    // would litter easybill with clients.
    const metaKey = `upstream_client:${this.config.upstream.issuer}:${this.redirectUri}`;
    const stored = this.store.getMeta(metaKey);
    if (stored) {
      this.clientId = stored;
      const secret = this.store.getSecretMeta(`${metaKey}:secret`);
      if (secret) this.clientSecret = secret;
      return;
    }

    const registration = this.endpoints.registration_endpoint;
    if (!registration) {
      throw new Error(
        "easybill offers no dynamic client registration — set EASYBILL_OAUTH_CLIENT_ID (and _SECRET) instead",
      );
    }
    const allScopes = [...new Set(this.config.tenants.flatMap((t) => t.scopes))].join(" ");
    const register = async (authMethod: string): Promise<Response> =>
      fetch(registration, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": userAgent },
        body: JSON.stringify({
          client_name: `easybill MCP (${this.config.publicUrl.host})`,
          redirect_uris: [this.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: authMethod,
          scope: allScopes,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

    // A confidential client is preferable; fall back to a public one if refused.
    let response = await register("client_secret_post");
    if (!response.ok) response = await register("none");
    const text = await response.text();
    if (!response.ok) {
      // easybill only allows dynamic registration for an allowlist of redirect
      // URIs (claude.ai and similar); a self-hosted callback needs a client
      // issued by easybill support.
      throw new Error(
        `easybill refused to register an OAuth client for ${this.redirectUri} (${response.status}: ${text.slice(0, 300)}). ` +
          `easybill only allows dynamic registration for known redirect URIs. Ask easybill support for an OAuth client ` +
          `with this redirect URI and set EASYBILL_OAUTH_CLIENT_ID and EASYBILL_OAUTH_CLIENT_SECRET.`,
      );
    }
    const body = JSON.parse(text) as { client_id?: string; client_secret?: string };
    if (!body.client_id) throw new Error("easybill client registration returned no client_id");

    this.clientId = body.client_id;
    this.store.setMeta(metaKey, body.client_id);
    if (body.client_secret) {
      this.clientSecret = body.client_secret;
      this.store.setSecretMeta(`${metaKey}:secret`, body.client_secret);
    }
    console.error(`Registered OAuth client ${body.client_id} with easybill (redirect ${this.redirectUri})`);
  }

  authorizationUrl(state: string, codeChallenge: string, scopes: string[]): string {
    const url = new URL(this.endpoints.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId!);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.href;
  }

  exchangeCode(code: string, codeVerifier: string): Promise<UpstreamTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<UpstreamTokens> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async tokenRequest(params: Record<string, string>): Promise<UpstreamTokens> {
    const body = new URLSearchParams({ ...params, client_id: this.clientId! });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    let response: Response;
    try {
      response = await fetch(this.endpoints.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": userAgent,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamOAuthError(
        `easybill token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
        "network",
        false,
      );
    }

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }

    if (!response.ok) {
      const code = typeof json.error === "string" ? json.error : `http_${response.status}`;
      const description =
        typeof json.error_description === "string" ? json.error_description : (json.message as string) ?? text.slice(0, 200);
      // invalid_grant / invalid_request on a refresh: the refresh token is dead.
      const permanent = response.status === 400 || response.status === 401;
      throw new UpstreamOAuthError(`easybill refused the token request: ${code} ${description}`.trim(), code, permanent);
    }

    const accessToken = json.access_token;
    const refreshToken = json.refresh_token ?? params.refresh_token;
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      throw new UpstreamOAuthError("easybill token response lacks access_token/refresh_token", "bad_response", false);
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      access_expires_at: now + expiresIn,
      refresh_expires_at: now + UPSTREAM_REFRESH_TTL_SECONDS,
    };
  }
}

/**
 * Hands out a valid easybill access token per (grant, tenant), refreshing when
 * it is about to expire. Concurrent callers share one refresh: easybill rotates
 * refresh tokens, so two parallel refreshes would invalidate each other.
 */
export class ConnectionTokens {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: Store,
    /** Absent in API-key mode. */
    private readonly oauth: EasybillOAuth | undefined,
  ) {}

  async accessToken(grantId: string, tenantId: string, forceRefresh = false): Promise<string> {
    const connection = this.store.getConnection(grantId, tenantId);
    if (!connection) throw new ReconnectRequiredError(tenantId, "not connected");
    if (connection.broken_reason) throw new ReconnectRequiredError(tenantId, connection.broken_reason);

    // A personal API key does not expire on a schedule; a 401 means it was
    // regenerated or the login removed, and only the person can fix that.
    if (connection.auth_kind === "apikey") {
      if (!forceRefresh) return connection.access_token;
      const reason = "easybill rejected the API key — it was probably regenerated or the login removed";
      this.store.markConnectionBroken(grantId, tenantId, reason);
      throw new ReconnectRequiredError(tenantId, reason);
    }

    const now = Math.floor(Date.now() / 1000);
    if (!forceRefresh && connection.access_expires_at - 60 > now) return connection.access_token;

    const key = `${grantId}\u0000${tenantId}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const refresh = (async (): Promise<string> => {
      try {
        if (!this.oauth) throw new ReconnectRequiredError(tenantId, "easybill OAuth is not configured on this server");
        const tokens = await this.oauth.refresh(connection.refresh_token);
        this.store.updateConnectionTokens(grantId, tenantId, tokens);
        return tokens.access_token;
      } catch (error) {
        if (error instanceof UpstreamOAuthError && error.permanent) {
          this.store.markConnectionBroken(grantId, tenantId, "login expired or access revoked in easybill");
          throw new ReconnectRequiredError(tenantId, "login expired or access revoked in easybill");
        }
        throw error;
      }
    })().finally(() => this.inflight.delete(key));

    this.inflight.set(key, refresh);
    return refresh;
  }
}
