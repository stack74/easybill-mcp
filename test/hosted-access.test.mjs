/**
 * Hosted mode behind Cloudflare Access: the connect pages require a valid Access
 * token, while the endpoints claude.ai calls from its servers stay open.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Browser } from "./helpers/connect-form.mjs";
import { SERVER_ENTRY } from "./helpers/mcp-client.mjs";

const AUD = "access-app-aud-123";

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

describe("hosted mode behind Cloudflare Access", () => {
  let certs;
  let issuer;
  let privateKey;
  let child;
  let dataDir;
  let base;

  const token = (claims = {}, audience = AUD) =>
    new SignJWT({ email: "erika@example.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  before(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const certsPort = await freePort();
    issuer = `http://127.0.0.1:${certsPort}`;
    certs = http.createServer((req, res) => {
      // Also plays easybill's REST API for the API-key check of the owner test.
      if (req.url.startsWith("/rest/v1/logins")) {
        const ok = req.headers.authorization === "Bearer key-erika";
        res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(ok ? { items: [{ id: 1, first_name: "Erika", last_name: "Muster" }] } : {}));
      }
      res.writeHead(req.url === "/cdn-cgi/access/certs" ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((r) => certs.listen(certsPort, "127.0.0.1", r));

    const port = await freePort();
    base = `http://localhost:${port}`;
    dataDir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-access-"));
    writeFileSync(path.join(dataDir, "icon.svg"), ICON);
    child = spawn("node", [SERVER_ENTRY, "--http"], {
      env: {
        ...process.env,
        EASYBILL_API_KEY: "",
        EASYBILL_CONNECT_MODE: "",
        EASYBILL_OAUTH_CLIENT_ID: "",
        PORT: String(port),
        HOST: "127.0.0.1",
        EASYBILL_PUBLIC_URL: base,
        EASYBILL_MCP_SECRET: "test-secret-test-secret-test-secret-1234",
        EASYBILL_DB_PATH: path.join(dataDir, "db.sqlite"),
        EASYBILL_BASE_URL: `${issuer}/rest/v1`,
        EASYBILL_MAX_RETRIES: "0",
        EASYBILL_TENANTS: JSON.stringify([{ id: "Alpha", name: "Alpha GmbH", plan: "PREMIUM" }]),
        EASYBILL_CF_ACCESS_TEAM_DOMAIN: issuer,
        EASYBILL_CF_ACCESS_AUD: AUD,
        EASYBILL_ICON_PATH: path.join(dataDir, "icon.svg"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(d.toString()));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`hosted server did not start:\n${stderr.join("")}`);
  });

  after(() => {
    child?.kill();
    certs?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function openConnectPage() {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    const { client_id } = await reg.json();
    const authorize = new URL("/authorize", base);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id,
      redirect_uri: "http://localhost:9999/cb",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    })) {
      authorize.searchParams.set(k, v);
    }
    const res = await fetch(authorize, { redirect: "manual" });
    assert.equal(res.status, 302, "/authorize stays outside Access");
    return res.headers.get("location");
  }

  it("refuses the connect page without an Access token", async () => {
    const page = await openConnectPage();
    const res = await fetch(new URL(page, base));
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Cloudflare Access/);
  });

  it("refuses an Access token for a different application", async () => {
    const page = await openConnectPage();
    const res = await fetch(new URL(page, base), {
      headers: { "Cf-Access-Jwt-Assertion": await token({}, "some-other-app") },
    });
    assert.equal(res.status, 403);
  });

  it("shows the connect page with a valid token, header or cookie, and who is signed in", async () => {
    const page = await openConnectPage();
    const viaHeader = await fetch(new URL(page, base), { headers: { "Cf-Access-Jwt-Assertion": await token() } });
    assert.equal(viaHeader.status, 200);
    const html = await viaHeader.text();
    assert.match(html, /Angemeldet als erika@example\.com/);
    assert.match(html, /tenants\/alpha\/key/, "tenant ids are lower-cased");

    const viaCookie = await fetch(new URL(page, base), { headers: { Cookie: `CF_Authorization=${await token()}` } });
    assert.equal(viaCookie.status, 200);
  });

  it("leaves the endpoints claude.ai calls server-to-server open", async () => {
    assert.equal((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status, 200);
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 200);
    const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(mcp.status, 401, "/mcp answers with the OAuth challenge, not the Access wall");
  });

  it("serves the configured icon without Access and links it from the pages", async () => {
    for (const route of ["/favicon.ico", "/favicon.svg"]) {
      const res = await fetch(`${base}${route}`);
      assert.equal(res.status, 200, route);
      assert.equal(res.headers.get("content-type"), "image/svg+xml", route);
      assert.equal(await res.text(), ICON, route);
    }
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  });

  it("binds a grant to the person who finished its first authorization", async () => {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:9999/cb"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    const { client_id } = await reg.json();
    const verifier = randomBytes(32).toString("base64url");
    const authorize = async () => {
      const url = new URL("/authorize", base);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })) {
        url.searchParams.set(k, v);
      }
      return (await fetch(url, { redirect: "manual" })).headers.get("location");
    };

    // Erika connects and finishes: the grant is hers from now on.
    const erika = new Browser(base, { CF_Authorization: await token() });
    const connect = await authorize();
    assert.equal((await erika.post(`${connect}/tenants/alpha/key`, { api_key: "key-erika" })).status, 303);
    const finish = await erika.post(`${connect}/finish`);
    assert.equal(finish.status, 303);
    const code = new URL(finish.headers.get("location")).searchParams.get("code");
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: "http://localhost:9999/cb",
      }),
    });
    const { access_token } = await tokenRes.json();
    const accounts = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "easybill_list_accounts", arguments: {} } }),
    });
    const manage = new URL((await accounts.json()).result.structuredContent.connect_url).pathname;

    // Max got the manage link forwarded; his browser has no grant cookie, but Access knows him.
    const max = new Browser(base, { CF_Authorization: await token({ email: "max@example.com" }) });
    for (const p of [manage, `${manage}/tenants/alpha/key`]) {
      const res = await max.fetch(p);
      assert.equal(res.status, 403, p);
      const html = await res.text();
      assert.match(html, /Claude-Zugang einer anderen Person/);
      assert.doesNotMatch(html, /erika/i, "the owner's address is not revealed");
      assert.doesNotMatch(html, /<form/);
    }
    assert.equal((await max.post(`${manage}/finish`, {}, "x")).status, 403);

    // Erika herself, in another browser and with different capitalisation, gets in.
    const erikaElsewhere = new Browser(base, { CF_Authorization: await token({ email: "ERIKA@Example.com" }) });
    const page = await erikaElsewhere.fetch(manage);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /verwaltet einen bestehenden Claude-Zugang/);

    // A grant nobody finished yet has no owner: Max can start his own connection.
    const own = await max.fetch(await authorize());
    assert.equal(own.status, 200);
  });
});
