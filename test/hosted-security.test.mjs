/**
 * Hosted mode: who may receive the access (confused deputy) and CSRF on the
 * connect page.
 *
 * The attack: someone registers their own MCP client with their own redirect
 * URI, starts /authorize and sends a colleague the /connect/<sid> link. If the
 * colleague connects their easybill accounts and presses "Fertig", the code
 * would go to the attacker. Guarded by a redirect allowlist (registration and
 * /authorize), by the connect page naming the app and the redirect target, and
 * by CSRF tokens bound to the browser on every form, so a foreign page — or
 * someone who opened the same link in their own browser — cannot submit them.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../dist/hosted/store.js";
import { Browser } from "./helpers/connect-form.mjs";
import { SERVER_ENTRY } from "./helpers/mcp-client.mjs";

const LOOPBACK = "http://localhost:9999/callback";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Starts the hosted server (API-key mode, never contacts easybill in these tests). */
async function startHosted(env = {}, options = {}) {
  const port = options.port ?? (await freePort());
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "easybill-mcp-security-"));
  const base = `http://localhost:${port}`;
  const child = spawn("node", [SERVER_ENTRY, "--http"], {
    env: {
      ...process.env,
      EASYBILL_API_KEY: "",
      EASYBILL_CONNECT_MODE: "",
      EASYBILL_OAUTH_CLIENT_ID: "",
      EASYBILL_ALLOWED_REDIRECT_URIS: "",
      EASYBILL_DEFAULT_REDIRECT_URIS: "",
      EASYBILL_CF_ACCESS_TEAM_DOMAIN: "",
      EASYBILL_CF_ACCESS_AUD: "",
      PORT: String(port),
      HOST: "127.0.0.1",
      EASYBILL_PUBLIC_URL: base,
      EASYBILL_MCP_SECRET: "test-secret-test-secret-test-secret-1234",
      EASYBILL_DB_PATH: path.join(dir, "db.sqlite"),
      EASYBILL_OAUTH_ISSUER: "http://127.0.0.1:1",
      EASYBILL_BASE_URL: "http://127.0.0.1:1/rest/v1",
      EASYBILL_TENANTS: JSON.stringify([{ id: "alpha", name: "Alpha GmbH", plan: "PREMIUM", writes: true }]),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const stop = ({ keepData = false } = {}) => {
    child.kill();
    if (!keepData) rmSync(dir, { recursive: true, force: true });
    return exited;
  };
  if (options.expectFailure) return { exited, get stderr() { return stderr; }, stop };
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        return { base, port, dir, stop, get stderr() { return stderr; } };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(`hosted server did not start:\n${stderr}`);
}

function register(base, redirect = LOOPBACK, name = "test client") {
  return fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(name ? { client_name: name } : {}),
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

function authorizeUrl(base, clientId, redirect) {
  const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
  const url = new URL("/authorize", base);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
  }).toString();
  return url;
}

/** Registers a client and starts /authorize; returns the connect page path. */
async function beginAuthorization(base, redirect = LOOPBACK, name = "test client") {
  const reg = await register(base, redirect, name);
  assert.equal(reg.status, 201, await reg.clone().text());
  const { client_id } = await reg.json();
  const res = await fetch(authorizeUrl(base, client_id, redirect), { redirect: "manual" });
  assert.equal(res.status, 302);
  return res.headers.get("location");
}

describe("hosted mode: who may receive the access (confused deputy)", () => {
  it("only lets known redirect URIs register; EASYBILL_ALLOWED_REDIRECT_URIS extends the defaults", async () => {
    const server = await startHosted({ EASYBILL_ALLOWED_REDIRECT_URIS: "https://app.example.com/oauth/callback" });
    try {
      const evil = await register(server.base, "https://attacker.example/steal");
      assert.equal(evil.status, 400);
      assert.equal((await evil.json()).error, "invalid_redirect_uri");
      // Look-alikes of allowed hosts and other paths on allowed hosts do not pass.
      for (const uri of [
        "https://claude.ai.attacker.example/api/mcp/auth_callback",
        "http://localhost.attacker.example/cb",
        "http://127.0.0.1.attacker.example/cb",
        "https://claude.ai/other",
        "http://claude.ai/api/mcp/auth_callback",
        "http://user@localhost:9999/cb",
        "https://app.example.com/oauth/callback/../../steal",
      ]) {
        assert.equal((await register(server.base, uri)).status, 400, uri);
      }
      for (const uri of [
        CLAUDE,
        "https://claude.com/api/mcp/auth_callback",
        "http://localhost:53682/callback",
        "http://127.0.0.1:8080/",
        "http://[::1]:33418/cb",
        "https://app.example.com/oauth/callback",
      ]) {
        assert.equal((await register(server.base, uri)).status, 201, uri);
      }
      assert.match(server.stderr, /Client registration refused: redirect URI\(s\) not allowed: https:\/\/attacker\.example\/steal/);
    } finally {
      await server.stop();
    }
  });

  it("EASYBILL_DEFAULT_REDIRECT_URIS=false drops the defaults", async () => {
    const strict = await startHosted({
      EASYBILL_DEFAULT_REDIRECT_URIS: "false",
      EASYBILL_ALLOWED_REDIRECT_URIS: CLAUDE,
    });
    try {
      assert.equal((await register(strict.base, "http://localhost:53682/callback")).status, 400);
      assert.equal((await register(strict.base, "https://claude.com/api/mcp/auth_callback")).status, 400);
      assert.equal((await register(strict.base, CLAUDE)).status, 201);
    } finally {
      await strict.stop();
    }
  });

  it("refuses to start with an empty allowlist", async () => {
    const server = await startHosted({ EASYBILL_DEFAULT_REDIRECT_URIS: "false" }, { expectFailure: true });
    try {
      assert.notEqual(await server.exited, 0);
      assert.match(server.stderr, /no redirect URIs allowed/);
    } finally {
      await server.stop();
    }
  });

  it("refuses /authorize for clients registered before the list was narrowed — without redirecting", async () => {
    const loose = await startHosted({ EASYBILL_ALLOWED_REDIRECT_URIS: "https://old.example/cb" });
    const reg = await register(loose.base, "https://old.example/cb");
    assert.equal(reg.status, 201);
    const { client_id } = await reg.json();
    await loose.stop({ keepData: true });
    const narrowed = await startHosted({}, { dir: loose.dir, port: loose.port });
    try {
      const res = await fetch(authorizeUrl(narrowed.base, client_id, "https://old.example/cb"), { redirect: "manual" });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
      assert.match(await res.text(), /Weiterleitungsadresse ist nicht erlaubt/);
      assert.match(narrowed.stderr, /Authorization refused for client .*https:\/\/old\.example\/cb not allowed/);
    } finally {
      await narrowed.stop();
    }
  });

  it("shows on the connect page which app asks and where the access goes", async () => {
    const server = await startHosted();
    try {
      const local = await (await fetch(new URL(await beginAuthorization(server.base, LOOPBACK, "Evil <b>Tool</b>"), server.base))).text();
      assert.match(local, /„Evil &lt;b&gt;Tool&lt;\/b&gt;“<\/b> möchte Zugriff/, "client name shown, escaped");
      assert.match(local, /deinem eigenen Computer<\/b> \(localhost:9999\)/);
      assert.match(local, /nicht geprüft/, "the name is marked as self-declared");
      assert.match(local, /nicht selbst in Claude gestartet/);

      const remote = await (await fetch(new URL(await beginAuthorization(server.base, CLAUDE, ""), server.base))).text();
      assert.match(remote, /Eine App ohne Namen/);
      assert.match(remote, /<b>claude\.ai<\/b> <span class="hint">\/api\/mcp\/auth_callback<\/span>/);
    } finally {
      await server.stop();
    }
  });
});

describe("hosted mode: CSRF on the connect page", () => {
  it("binds every form to a per-browser nonce cookie and refuses posts without it", async () => {
    const server = await startHosted();
    try {
      const connectPath = await beginAuthorization(server.base);
      const page = await fetch(new URL(connectPath, server.base));
      const html = await page.text();
      const setCookie = page.headers.getSetCookie();
      assert.equal(setCookie.length, 1, "only the browser cookie");
      assert.match(setCookie[0], /^easybill_mcp_browser=[A-Za-z0-9_-]{43};/, "plain name over http");
      assert.match(setCookie[0], /HttpOnly/i);
      assert.match(setCookie[0], /SameSite=Lax/i);
      assert.match(setCookie[0], /Path=\/(;|$)/);
      assert.doesNotMatch(setCookie[0], /Secure/i, "plain http on localhost: no Secure flag");
      assert.doesNotMatch(setCookie[0], /Domain=/i);
      // Every POST form carries the token.
      const postForms = html.match(/<form method="post"[^>]*>/g) ?? [];
      const withToken = html.match(/<form method="post"[^>]*><input type="hidden" name="csrf"|<form method="post"[^>]*>\s*<input type="hidden" name="csrf"/g) ?? [];
      assert.ok(postForms.length >= 2, "cancel and finish at least");
      assert.equal(withToken.length, postForms.length, "every POST form carries the CSRF token");

      const victim = new Browser(server.base);
      const csrf = await victim.csrf(connectPath);
      // The browser keeps its nonce: a second visit sets no new cookie and renders the same token.
      const again = await victim.fetch(connectPath);
      assert.deepEqual(again.headers.getSetCookie(), []);
      assert.equal(/name="csrf" value="([^"]+)"/.exec(await again.text())[1], csrf);

      const anonymous = new Browser(server.base);
      // A cross-site form post knows the session id (and at best a token), never the cookie.
      for (const p of ["finish", "cancel", "tenants/alpha/key", "tenants/alpha/disconnect", "tenants/alpha/connect"]) {
        const res = await anonymous.post(`${connectPath}/${p}`, {}, csrf);
        assert.equal(res.status, 403, `${p} without cookie`);
        assert.equal(res.headers.get("location"), null, `${p} must not redirect`);
        assert.match(await res.text(), /nicht bestätigt werden/);
      }
      assert.equal((await victim.post(`${connectPath}/finish`, {}, null)).status, 403, "cookie but no field");
      assert.equal((await victim.post(`${connectPath}/finish`, {}, `${csrf.slice(0, -1)}x`)).status, 403, "wrong field");
      const malformed = new Browser(server.base, { easybill_mcp_browser: "short" });
      assert.equal((await malformed.post(`${connectPath}/finish`, {}, csrf)).status, 403, "malformed cookie");
      // A token of another session does not help.
      const otherSession = await victim.csrf(await beginAuthorization(server.base));
      assert.equal((await victim.post(`${connectPath}/cancel`, {}, otherSession)).status, 403, "token of another session");

      // The session is untouched and still works with the right cookie and token.
      const finish = await victim.post(`${connectPath}/finish`);
      assert.equal(finish.status, 303);
      assert.match(finish.headers.get("location"), /e=none_connected/);
      const cancel = await victim.post(`${connectPath}/cancel`, {}, csrf);
      assert.equal(cancel.status, 303);
      const target = new URL(cancel.headers.get("location"));
      assert.equal(`${target.origin}${target.pathname}`, LOOPBACK);
      assert.equal(target.searchParams.get("error"), "access_denied");
    } finally {
      await server.stop();
    }
  });

  it("refuses a token that was rendered for another browser", async () => {
    const server = await startHosted();
    try {
      const connectPath = await beginAuthorization(server.base);
      const victim = new Browser(server.base);
      const victimToken = await victim.csrf(connectPath);
      const other = new Browser(server.base);
      const otherToken = await other.csrf(connectPath);
      assert.notEqual(victimToken, otherToken, "the token depends on the browser, not only on the session");
      assert.notEqual(victim.browserCookie, other.browserCookie);

      // A token copied from another browser does not fit this browser's cookie.
      assert.equal((await other.post(`${connectPath}/finish`, {}, victimToken)).status, 403);
      // The attacker scenario: someone who knows the link (and so can open the page) takes the
      // token rendered for their own browser and makes the victim's browser post it — e.g. from a
      // sibling subdomain, which is same-site, so the victim's cookie is sent along.
      const attack = await victim.post(`${connectPath}/cancel`, {}, otherToken);
      assert.equal(attack.status, 403);
      assert.equal(attack.headers.get("location"), null);
      // Planting a cookie of the attacker's choosing would make their token fit — over https
      // the __Host- prefix rules that out (see the next test); the session is unharmed here.
      const finish = await victim.post(`${connectPath}/finish`, {}, victimToken);
      assert.equal(finish.status, 303);
      assert.match(finish.headers.get("location"), /e=none_connected/, "still the same, working session");
    } finally {
      await server.stop();
    }
  });

  it("uses a __Host- cookie (Secure, Path=/, no Domain) when the public URL is https", async () => {
    const port = await freePort();
    const server = await startHosted({ EASYBILL_PUBLIC_URL: `https://127.0.0.1:${port}` }, { port });
    try {
      // The server sits behind TLS termination; the test talks to it directly over http.
      const connectPath = await beginAuthorization(server.base);
      const page = await fetch(new URL(connectPath, server.base));
      assert.equal(page.status, 200);
      const [setCookie, ...more] = page.headers.getSetCookie();
      assert.equal(more.length, 0);
      assert.match(setCookie, /^__Host-easybill_mcp_browser=[A-Za-z0-9_-]{43};/);
      assert.match(setCookie, /;\s*Secure(;|$)/i);
      assert.match(setCookie, /;\s*Path=\/(;|$)/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.doesNotMatch(setCookie, /Domain=/i);

      // The forms work with that cookie, and only with that name.
      const browser = new Browser(server.base);
      const csrf = await browser.csrf(connectPath);
      const nonce = browser.browserCookie.split("=")[1];
      const plain = new Browser(server.base, { easybill_mcp_browser: nonce });
      assert.equal((await plain.post(`${connectPath}/finish`, {}, csrf)).status, 403, "the unprefixed name is not read over https");
      const finish = await browser.post(`${connectPath}/finish`, {}, csrf);
      assert.equal(finish.status, 303);
    } finally {
      await server.stop();
    }
  });

  it("puts the token into the API-key form and sets the cookie there too", async () => {
    const server = await startHosted();
    try {
      const connectPath = await beginAuthorization(server.base);
      const form = await fetch(new URL(`${connectPath}/tenants/alpha/key`, server.base));
      assert.equal(form.status, 200);
      assert.match(form.headers.get("set-cookie") ?? "", /^easybill_mcp_browser=.*SameSite=Lax/i);
      const html = await form.text();
      assert.match(html, /name="csrf" value="[^"]+"/);
      assert.doesNotMatch(html, /verwaltet einen bestehenden Claude-Zugang/, "no manage warning during an authorization");
    } finally {
      await server.stop();
    }
  });
});

describe("hosted mode: grant owners in the database", () => {
  it("adds the owner column to a database from an older version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-migrate-"));
    try {
      const file = path.join(dir, "db.sqlite");
      const old = new DatabaseSync(file);
      old.exec("CREATE TABLE grants (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)");
      old.prepare("INSERT INTO grants (id, created_at, last_used_at) VALUES ('g-old', 1, 1)").run();
      old.close();

      const store = new Store(file, "test-secret-test-secret-test-secret-1234");
      try {
        assert.equal(store.grantExists("g-old"), true, "existing grants survive");
        assert.equal(store.getGrantOwner("g-old"), null, "old grants have no owner");
        store.claimGrantOwner("g-old", " Erika@Example.com ");
        assert.equal(store.getGrantOwner("g-old"), "erika@example.com");
        store.claimGrantOwner("g-old", "max@example.com");
        assert.equal(store.getGrantOwner("g-old"), "erika@example.com", "an owner is never replaced");
      } finally {
        store.close();
      }
      // Opening it again does not migrate twice.
      new Store(file, "test-secret-test-secret-test-secret-1234").close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
