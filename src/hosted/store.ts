/**
 * Persistent state for hosted mode, in SQLite (node:sqlite, no extra dependency).
 *
 * Vocabulary:
 *  - grant:      one person's bundle of easybill connections. Every token this
 *                server issues to an MCP client points at a grant.
 *  - connection: a grant's OAuth tokens for one tenant (easybill account).
 *  - session:    a short-lived visit to the connect page, either during the MCP
 *                client's OAuth authorization ("authorize") or from a link the
 *                model handed out ("manage").
 *
 * Secrets at rest: easybill tokens are AES-256-GCM encrypted; tokens this server
 * issues are stored only as SHA-256 hashes.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface SessionRow {
  id: string;
  kind: "authorize" | "manage";
  grant_id: string;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  state: string | null;
  resource: string | null;
  expires_at: number;
}

export interface ConnectionRow {
  grant_id: string;
  tenant_id: string;
  /** "apikey": a personal easybill API key in access_token. "oauth": easybill OAuth tokens. */
  auth_kind: "apikey" | "oauth";
  access_token: string;
  refresh_token: string;
  access_expires_at: number;
  refresh_expires_at: number;
  /** Who logged in, for display: name / email from easybill. */
  login_label: string | null;
  claims: Record<string, unknown>;
  connected_at: number;
  /** Set when a refresh failed for good; the person has to reconnect. */
  broken_reason: string | null;
}

export interface TokenRow {
  kind: "access" | "refresh";
  grant_id: string;
  client_id: string;
  resource: string | null;
  expires_at: number;
}

export interface CodeRow {
  grant_id: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string | null;
  expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, owner TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT, redirect_uri TEXT,
  code_challenge TEXT, state TEXT, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS upstream_states (
  state TEXT PRIMARY KEY, session_id TEXT NOT NULL, tenant_id TEXT NOT NULL, code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  grant_id TEXT NOT NULL, tenant_id TEXT NOT NULL, auth_kind TEXT NOT NULL DEFAULT 'oauth',
  access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL, refresh_expires_at INTEGER NOT NULL, login_label TEXT, claims TEXT NOT NULL,
  connected_at INTEGER NOT NULL, broken_reason TEXT, PRIMARY KEY (grant_id, tenant_id));
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  resource TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dbPath: string, secret: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.key = Buffer.from(hkdfSync("sha256", secret, "easybill-mcp", "token-encryption", 32));
  }

  close(): void {
    this.db.close();
  }

  /** Brings databases created by older versions up to the current schema. */
  private migrate(): void {
    const grantColumns = this.db.prepare("PRAGMA table_info(grants)").all() as { name: string }[];
    if (!grantColumns.some((c) => c.name === "owner")) this.db.exec("ALTER TABLE grants ADD COLUMN owner TEXT");
  }

  // --- encryption --------------------------------------------------------

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  private decrypt(stored: string): string {
    const raw = Buffer.from(stored, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  // --- meta --------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Secret metadata (the upstream client secret) goes through here. */
  getSecretMeta(key: string): string | undefined {
    const value = this.getMeta(key);
    return value === undefined ? undefined : this.decrypt(value);
  }

  setSecretMeta(key: string, value: string): void {
    this.setMeta(key, this.encrypt(value));
  }

  // --- OAuth clients (MCP clients that registered with us) ---------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare("INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), nowSeconds());
  }

  // --- grants ------------------------------------------------------------

  createGrant(): string {
    const id = randomToken(18);
    const now = nowSeconds();
    this.db.prepare("INSERT INTO grants (id, created_at, last_used_at) VALUES (?, ?, ?)").run(id, now, now);
    return id;
  }

  grantExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM grants WHERE id = ?").get(id) !== undefined;
  }

  touchGrant(id: string): void {
    this.db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(nowSeconds(), id);
  }

  /**
   * The person a grant belongs to (Cloudflare Access e-mail, lower-cased), or
   * null when not known: grants from before owners were recorded, or without Access.
   */
  getGrantOwner(id: string): string | null {
    const row = this.db.prepare("SELECT owner FROM grants WHERE id = ?").get(id) as { owner: string | null } | undefined;
    return row?.owner ?? null;
  }

  /** Records the owner unless the grant already has one; an owner never changes. */
  claimGrantOwner(id: string, owner: string): void {
    this.db.prepare("UPDATE grants SET owner = ? WHERE id = ? AND owner IS NULL").run(owner.trim().toLowerCase(), id);
  }

  // --- connect-page sessions --------------------------------------------

  createSession(row: Omit<SessionRow, "id" | "expires_at">, ttlSeconds: number): string {
    const id = randomToken();
    this.db
      .prepare(
        "INSERT INTO sessions (id, kind, grant_id, client_id, redirect_uri, code_challenge, state, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        row.kind,
        row.grant_id,
        row.client_id,
        row.redirect_uri,
        row.code_challenge,
        row.state,
        row.resource,
        nowSeconds() + ttlSeconds,
      );
    return id;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // --- upstream (easybill) authorization in flight ------------------------

  createUpstreamState(sessionId: string, tenantId: string, codeVerifier: string): string {
    const state = randomToken();
    this.db
      .prepare("INSERT INTO upstream_states (state, session_id, tenant_id, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(state, sessionId, tenantId, this.encrypt(codeVerifier), nowSeconds() + 900);
    return state;
  }

  /** Single use: the row is deleted as it is read. */
  takeUpstreamState(state: string): { sessionId: string; tenantId: string; codeVerifier: string } | undefined {
    const row = this.db.prepare("SELECT * FROM upstream_states WHERE state = ?").get(state) as
      | { session_id: string; tenant_id: string; code_verifier: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    this.db.prepare("DELETE FROM upstream_states WHERE state = ?").run(state);
    if (row.expires_at < nowSeconds()) return undefined;
    return { sessionId: row.session_id, tenantId: row.tenant_id, codeVerifier: this.decrypt(row.code_verifier) };
  }

  // --- connections -------------------------------------------------------

  saveConnection(row: Omit<ConnectionRow, "broken_reason">): void {
    this.db
      .prepare(
        `INSERT INTO connections (grant_id, tenant_id, auth_kind, access_token, refresh_token, access_expires_at, refresh_expires_at, login_label, claims, connected_at, broken_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(grant_id, tenant_id) DO UPDATE SET auth_kind = excluded.auth_kind, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at,
           login_label = excluded.login_label, claims = excluded.claims, connected_at = excluded.connected_at, broken_reason = NULL`,
      )
      .run(
        row.grant_id,
        row.tenant_id,
        row.auth_kind,
        this.encrypt(row.access_token),
        this.encrypt(row.refresh_token),
        row.access_expires_at,
        row.refresh_expires_at,
        row.login_label,
        JSON.stringify(row.claims),
        row.connected_at,
      );
  }

  updateConnectionTokens(
    grantId: string,
    tenantId: string,
    tokens: { access_token: string; refresh_token: string; access_expires_at: number; refresh_expires_at: number },
  ): void {
    this.db
      .prepare(
        "UPDATE connections SET access_token = ?, refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, broken_reason = NULL WHERE grant_id = ? AND tenant_id = ?",
      )
      .run(
        this.encrypt(tokens.access_token),
        this.encrypt(tokens.refresh_token),
        tokens.access_expires_at,
        tokens.refresh_expires_at,
        grantId,
        tenantId,
      );
  }

  markConnectionBroken(grantId: string, tenantId: string, reason: string): void {
    this.db
      .prepare("UPDATE connections SET broken_reason = ? WHERE grant_id = ? AND tenant_id = ?")
      .run(reason, grantId, tenantId);
  }

  getConnection(grantId: string, tenantId: string): ConnectionRow | undefined {
    const row = this.db.prepare("SELECT * FROM connections WHERE grant_id = ? AND tenant_id = ?").get(grantId, tenantId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.decodeConnection(row) : undefined;
  }

  listConnections(grantId: string): ConnectionRow[] {
    const rows = this.db.prepare("SELECT * FROM connections WHERE grant_id = ?").all(grantId) as Record<string, unknown>[];
    return rows.map((row) => this.decodeConnection(row));
  }

  deleteConnection(grantId: string, tenantId: string): void {
    this.db.prepare("DELETE FROM connections WHERE grant_id = ? AND tenant_id = ?").run(grantId, tenantId);
  }

  private decodeConnection(row: Record<string, unknown>): ConnectionRow {
    return {
      grant_id: String(row.grant_id),
      tenant_id: String(row.tenant_id),
      auth_kind: row.auth_kind === "apikey" ? "apikey" : "oauth",
      access_token: this.decrypt(String(row.access_token)),
      refresh_token: this.decrypt(String(row.refresh_token)),
      access_expires_at: Number(row.access_expires_at),
      refresh_expires_at: Number(row.refresh_expires_at),
      login_label: row.login_label === null ? null : String(row.login_label),
      claims: JSON.parse(String(row.claims)) as Record<string, unknown>,
      connected_at: Number(row.connected_at),
      broken_reason: row.broken_reason === null ? null : String(row.broken_reason),
    };
  }

  // --- tenant fingerprints ----------------------------------------------

  /**
   * The easybill login IDs seen when a tenant was first connected. An API key
   * carries no account identifier, so this is how we recognise "same company"
   * later: login IDs are unique across easybill.
   */
  getTenantFingerprint(tenantId: string): string[] | undefined {
    const raw = this.getMeta(`tenant_fingerprint:${tenantId}`);
    return raw ? (JSON.parse(raw) as string[]) : undefined;
  }

  setTenantFingerprint(tenantId: string, loginIds: string[]): void {
    this.setMeta(`tenant_fingerprint:${tenantId}`, JSON.stringify([...new Set(loginIds)].sort()));
  }

  /** All tenants' fingerprints, to refuse a key that belongs to a different tenant. */
  listTenantFingerprints(): Map<string, string[]> {
    const rows = this.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'tenant_fingerprint:%'").all() as {
      key: string;
      value: string;
    }[];
    return new Map(rows.map((r) => [r.key.slice("tenant_fingerprint:".length), JSON.parse(r.value) as string[]]));
  }

  // --- authorization codes (issued to MCP clients) -----------------------

  createCode(row: Omit<CodeRow, "expires_at">): string {
    const code = randomToken();
    this.db
      .prepare(
        "INSERT INTO auth_codes (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sha256(code), row.grant_id, row.client_id, row.code_challenge, row.redirect_uri, row.resource, nowSeconds() + 300);
    return code;
  }

  getCode(code: string): CodeRow | undefined {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(sha256(code)) as CodeRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteCode(code: string): void {
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
  }

  // --- tokens (issued to MCP clients) ------------------------------------

  createToken(row: Omit<TokenRow, "expires_at">, ttlSeconds: number): { token: string; expiresAt: number } {
    const token = randomToken();
    const expiresAt = nowSeconds() + ttlSeconds;
    this.db
      .prepare("INSERT INTO tokens (token_hash, kind, grant_id, client_id, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), row.kind, row.grant_id, row.client_id, row.resource, expiresAt);
    return { token, expiresAt };
  }

  getToken(token: string): TokenRow | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteToken(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(token));
  }

  // --- housekeeping ------------------------------------------------------

  /** Drops expired rows. Cheap; run it periodically. */
  purgeExpired(): void {
    const now = nowSeconds();
    for (const table of ["sessions", "upstream_states", "auth_codes", "tokens"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now);
    }
  }
}
