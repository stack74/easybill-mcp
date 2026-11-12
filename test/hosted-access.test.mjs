/**
 * Hosted mode behind Cloudflare Access: the connect pages require a valid Access
 * token, while the endpoints claude.ai calls from its servers stay open.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
      res.writeHead(req.url === "/cdn-cgi/access/certs" ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((r) => certs.listen(certsPort, "127.0.0.1", r));

    const port = await freePort();
    base = `http://localhost:${port}`;
    dataDir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-access-"));
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
        EASYBILL_TENANTS: JSON.stringify([{ id: "Alpha", name: "Alpha GmbH", plan: "PREMIUM" }]),
        EASYBILL_CF_ACCESS_TEAM_DOMAIN: issuer,
        EASYBILL_CF_ACCESS_AUD: AUD,
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
});
