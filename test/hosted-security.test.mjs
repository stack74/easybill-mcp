/**
 * Hosted mode: who may receive the access (confused deputy) and CSRF on the
 * connect page.
 *
 * The attack: someone registers their own MCP client with their own redirect
 * URI, starts /authorize and sends a colleague the /connect/<sid> link. If the
 * colleague connects their easybill accounts and presses "Fertig", the code
 * would go to the attacker. Guarded by a redirect allowlist (registration and
 * /authorize), by the connect page naming the app and the redirect target, and
 * by CSRF tokens on every form, so a foreign page cannot submit them.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { csrfFor, submitForm } from "./helpers/connect-form.mjs";
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
  it("binds every form to a SameSite=Strict cookie and refuses posts without it", async () => {
    const server = await startHosted();
    try {
      const connectPath = await beginAuthorization(server.base);
      const page = await fetch(new URL(connectPath, server.base));
      const html = await page.text();
      const setCookie = page.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^easybill_mcp_csrf=/);
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, new RegExp(`Path=${connectPath.replace(/[/]/g, "\\/")}(;|$)`));
      assert.doesNotMatch(setCookie, /Secure/i, "plain http on localhost: no Secure flag");
      // Every POST form carries the token.
      const postForms = html.match(/<form method="post"[^>]*>/g) ?? [];
      const withToken = html.match(/<form method="post"[^>]*><input type="hidden" name="csrf"|<form method="post"[^>]*>\s*<input type="hidden" name="csrf"/g) ?? [];
      assert.ok(postForms.length >= 2, "cancel and finish at least");
      assert.equal(withToken.length, postForms.length, "every POST form carries the CSRF token");

      const { cookie, csrf } = await csrfFor(server.base, connectPath);
      const post = (p, { withCookie = true, token = csrf } = {}) =>
        fetch(new URL(p, server.base), {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...(withCookie ? { Cookie: cookie } : {}) },
          body: new URLSearchParams(token === null ? {} : { csrf: token }),
        });

      // A cross-site form post knows the session id (and at best the token from the page), never the Strict cookie.
      for (const p of ["finish", "cancel", "tenants/alpha/key", "tenants/alpha/disconnect", "tenants/alpha/connect"]) {
        const res = await post(`${connectPath}/${p}`, { withCookie: false });
        assert.equal(res.status, 403, `${p} without cookie`);
        assert.equal(res.headers.get("location"), null, `${p} must not redirect`);
        assert.match(await res.text(), /nicht bestätigt werden/);
      }
      assert.equal((await post(`${connectPath}/finish`, { token: null })).status, 403, "cookie but no field");
      assert.equal((await post(`${connectPath}/finish`, { token: `${csrf.slice(0, -1)}x` })).status, 403, "wrong field");
      // A token of another session does not help.
      const other = await csrfFor(server.base, await beginAuthorization(server.base));
      assert.equal((await post(`${connectPath}/cancel`, { token: other.csrf })).status, 403, "token of another session");

      // The session is untouched and still works with the right cookie and token.
      const finish = await submitForm(server.base, `${connectPath}/finish`);
      assert.equal(finish.status, 303);
      assert.match(finish.headers.get("location"), /e=none_connected/);
      const cancel = await submitForm(server.base, `${connectPath}/cancel`);
      assert.equal(cancel.status, 303);
      const target = new URL(cancel.headers.get("location"));
      assert.equal(`${target.origin}${target.pathname}`, LOOPBACK);
      assert.equal(target.searchParams.get("error"), "access_denied");
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
      assert.match(form.headers.get("set-cookie") ?? "", /^easybill_mcp_csrf=.*SameSite=Strict/i);
      assert.match(await form.text(), /name="csrf" value="[^"]+"/);
    } finally {
      await server.stop();
    }
  });
});
