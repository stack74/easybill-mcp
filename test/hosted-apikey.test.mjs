/**
 * Hosted mode with personal API keys (the default connect mode): the real
 * server against a fake easybill REST API that knows a few keys.
 *
 * Flow: MCP client OAuth with this server -> connect page -> paste a key per
 * account -> tools routed by `account`.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SERVER_ENTRY } from "./helpers/mcp-client.mjs";

/** Companies and their logins. Login IDs are unique across easybill. */
const COMPANIES = {
  A: [
    { id: 101, first_name: "Erika", last_name: "Muster" },
    { id: 303, first_name: "Otto", last_name: "Normal" },
  ],
  B: [{ id: 202, first_name: "Max", last_name: "Beispiel" }],
};
/** API key -> company. key-a1 and key-a2 are two people at company A. */
const KEYS = { "key-a1": "A", "key-a2": "A", "key-b": "B" };

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function startFakeEasybill(port) {
  const state = { keys: { ...KEYS }, calls: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const company = state.keys[key];
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!company) return json(401, { message: "Unauthorized" });
    const p = url.pathname.replace(/^\/rest\/v1/, "");
    state.calls.push({ path: p, key });
    if (p === "/logins") return json(200, { page: 1, pages: 1, limit: 1000, total: COMPANIES[company].length, items: COMPANIES[company] });
    if (p === "/customers") {
      return json(200, { page: 1, pages: 1, limit: 100, total: 1, items: [{ id: 1, display_name: `Customer of company ${company}` }] });
    }
    json(404, { message: "not found" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${port}` })));
}

describe("hosted mode with personal API keys", () => {
  let fake;
  let child;
  let dataDir;
  let base;
  let mcpUrl;
  let clientId;
  let sessionPath;
  let accessToken;
  const redirectUri = "http://localhost:9999/callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const get = (p) => fetch(new URL(p, base), { redirect: "manual" });
  const postForm = (p, fields = {}) =>
    fetch(new URL(p, base), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });

  async function submitKey(tenant, key) {
    const form = await get(`${sessionPath}/tenants/${tenant}/key`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /Profil und Einstellungen/);
    return postForm(`${sessionPath}/tenants/${tenant}/key`, { api_key: key });
  }

  let rpcId = 1;
  async function callTool(name, args) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    });
    const message = await res.json();
    assert.ok(!message.error, JSON.stringify(message.error));
    return message.result;
  }

  before(async () => {
    fake = await startFakeEasybill(await freePort());
    const port = await freePort();
    base = `http://localhost:${port}`;
    mcpUrl = `${base}/mcp`;
    dataDir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-apikey-"));
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
        // Must never be contacted in API-key mode.
        EASYBILL_OAUTH_ISSUER: "http://127.0.0.1:1",
        EASYBILL_BASE_URL: `${fake.base}/rest/v1`,
        EASYBILL_MAX_RETRIES: "0",
        EASYBILL_TENANTS: JSON.stringify([
          { id: "alpha", name: "Alpha GmbH", plan: "PREMIUM", writes: true },
          { id: "beta", name: "Beta AG", plan: "professional" },
        ]),
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
    fake?.server.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts without contacting easybill's OAuth server and opens the connect page", async () => {
    const reg = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    clientId = (await reg.json()).client_id;
    const authorize = new URL("/authorize", base);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
      resource: mcpUrl,
    })) {
      authorize.searchParams.set(k, v);
    }
    const res = await fetch(authorize, { redirect: "manual" });
    sessionPath = res.headers.get("location");
    const page = await (await get(sessionPath)).text();
    assert.match(page, /persönlichen easybill-API-Key/);
    assert.match(page, /action="[^"]*\/tenants\/alpha\/key"/);
  });

  it("rejects a key easybill does not accept", async () => {
    const res = await submitKey("alpha", "not-a-key");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /nicht akzeptiert/);
  });

  it("accepts a valid key and pins the account to its logins", async () => {
    const res = await submitKey("alpha", "key-a1");
    assert.equal(res.status, 303);
    const page = await (await get(res.headers.get("location"))).text();
    assert.match(page, /Verbunden \(Key …y-a1\)/);
  });

  it("refuses a key of another company for an already pinned account", async () => {
    await postForm(`${sessionPath}/tenants/alpha/disconnect`);
    const res = await submitKey("alpha", "key-b");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /anderen easybill-Account als „Alpha GmbH“/);
  });

  it("accepts another person's key of the same company", async () => {
    const res = await submitKey("alpha", "key-a2");
    assert.equal(res.status, 303);
  });

  it("refuses a key that belongs to a different configured account", async () => {
    const res = await submitKey("beta", "key-a1");
    assert.equal(res.status, 400);
    assert.match(await res.text(), /gehört zu „Alpha GmbH“, nicht zu „Beta AG“/);
  });

  it("connects the second account and completes the MCP client's authorization", async () => {
    assert.equal((await submitKey("beta", "key-b")).status, 303);
    const finish = await postForm(`${sessionPath}/finish`);
    const target = new URL(finish.headers.get("location"));
    assert.equal(target.searchParams.get("state"), "s1");
    const token = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: target.searchParams.get("code"),
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
    });
    accessToken = (await token.json()).access_token;
    assert.ok(accessToken);
  });

  it("routes each tool call to that account's key", async () => {
    const a = await callTool("easybill_list_customers", { account: "alpha" });
    assert.match(a.content[0].text, /company A/);
    const b = await callTool("easybill_list_customers", { account: "beta" });
    assert.match(b.content[0].text, /company B/);
    const keys = fake.state.calls.filter((c) => c.path === "/customers").map((c) => c.key);
    assert.deepEqual(keys.slice(-2), ["key-a2", "key-b"]);
  });

  it("marks a revoked key and asks for a new one", async () => {
    delete fake.state.keys["key-b"];
    const result = await callTool("easybill_list_customers", { account: "beta" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /easybill_list_accounts/);
    const accounts = await callTool("easybill_list_accounts", {});
    assert.equal(accounts.structuredContent.accounts.find((x) => x.account === "beta").status, "expired");
    const page = await (await get(new URL(accounts.structuredContent.connect_url).pathname)).text();
    assert.match(page, /API-Key ungültig/);
  });
});
