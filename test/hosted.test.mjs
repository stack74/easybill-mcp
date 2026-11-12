/**
 * Hosted mode end to end: the real server (dist/index.js --http) against a fake
 * easybill that plays both OAuth authorization server and REST API.
 *
 * Walks the flow claude.ai performs: discovery, dynamic client registration,
 * authorize -> connect page -> easybill login per account -> code -> tokens,
 * then MCP calls routed by `account`.
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

const b64url = (value) => Buffer.from(value).toString("base64url");
const fakeJwt = (claims) => `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims))}.sig`;

/** Logins known to the fake easybill: login id -> company. */
const LOGINS = {
  101: { company: "A", first_name: "Erika", last_name: "Muster" },
  202: { company: "B", first_name: "Max", last_name: "Beispiel" },
  303: { company: "A", first_name: "Other", last_name: "Person" },
};

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** A minimal easybill: OAuth server + the REST endpoints the test touches. */
function startFakeEasybill(port) {
  const base = `http://127.0.0.1:${port}`;
  const state = {
    codes: new Map(), // code -> { login, challenge, redirect }
    access: new Map(), // token -> login
    refresh: new Map(), // token -> login
    refreshCount: 0,
    restCalls: [], // { path, login }
  };

  const issue = (login) => {
    const access = fakeJwt({ sub: String(login), cid: LOGINS[login].company, jti: randomBytes(4).toString("hex") });
    const refresh = randomBytes(16).toString("hex");
    state.access.set(access, login);
    state.refresh.set(refresh, login);
    return { token_type: "Bearer", expires_in: 3600, access_token: access, refresh_token: refresh };
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = "";
    for await (const chunk of req) body += chunk;

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth2/authorize`,
        token_endpoint: `${base}/oauth2/token`,
        registration_endpoint: `${base}/oauth2/register`,
      });
    }
    if (url.pathname === "/oauth2/register" && req.method === "POST") {
      state.registration = JSON.parse(body);
      return json(res, 201, { client_id: "upstream-client", client_secret: "upstream-secret" });
    }
    if (url.pathname === "/oauth2/authorize") {
      // The test passes ?login=<id> to simulate who logs in at easybill.
      const login = Number(url.searchParams.get("login"));
      const code = randomBytes(8).toString("hex");
      state.codes.set(code, {
        login,
        challenge: url.searchParams.get("code_challenge"),
        scope: url.searchParams.get("scope"),
      });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }
    if (url.pathname === "/oauth2/token" && req.method === "POST") {
      const p = new URLSearchParams(body);
      if (p.get("client_id") !== "upstream-client" || p.get("client_secret") !== "upstream-secret") {
        return json(res, 401, { error: "invalid_client" });
      }
      if (p.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(p.get("code"));
        state.codes.delete(p.get("code"));
        const verifierHash = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
        if (!entry || verifierHash !== entry.challenge) return json(res, 400, { error: "invalid_grant" });
        state.lastScope = entry.scope;
        return json(res, 200, issue(entry.login));
      }
      if (p.get("grant_type") === "refresh_token") {
        const login = state.refresh.get(p.get("refresh_token"));
        if (login === undefined) return json(res, 400, { error: "invalid_grant" });
        state.refresh.delete(p.get("refresh_token"));
        state.refreshCount++;
        return json(res, 200, issue(login));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const login = state.access.get(token);
      if (login === undefined) return json(res, 401, { message: "Unauthorized" });
      const restPath = url.pathname.slice("/rest/v1".length);
      state.restCalls.push({ path: restPath, login });
      const loginMatch = /^\/logins\/(\d+)$/.exec(restPath);
      if (loginMatch) return json(res, 200, { id: Number(loginMatch[1]), ...LOGINS[loginMatch[1]] });
      if (restPath === "/customers") {
        return json(res, 200, {
          page: 1,
          pages: 1,
          limit: 100,
          total: 1,
          items: [{ id: 1, display_name: `Customer of company ${LOGINS[login].company}` }],
        });
      }
      return json(res, 404, { message: "not found" });
    }
    json(res, 404, {});
  });

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state, base })));
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

describe("hosted mode (HTTP + OAuth)", () => {
  let fake;
  let child;
  let dataDir;
  let base;
  let mcpUrl;
  const redirectUri = "http://localhost:9999/callback";
  let clientId;
  let sessionPath;
  let grantCookie;
  let accessToken;
  let refreshToken;
  let codeVerifier;

  const get = (p, headers = {}) => fetch(new URL(p, base), { redirect: "manual", headers });
  const post = (p, headers = {}, body) => fetch(new URL(p, base), { method: "POST", redirect: "manual", headers, body });
  const location = (res) => res.headers.get("location");

  /** Clicks "Verbinden" for a tenant and logs in at the fake easybill as `login`. */
  async function connectTenant(tenant, login) {
    const start = await post(`${sessionPath}/tenants/${tenant}/connect`);
    assert.equal(start.status, 303);
    const upstreamAuthorize = new URL(location(start));
    assert.equal(upstreamAuthorize.origin, fake.base);
    upstreamAuthorize.searchParams.set("login", String(login));
    const upstream = await fetch(upstreamAuthorize, { redirect: "manual" });
    const callback = await fetch(location(upstream), { redirect: "manual" });
    assert.equal(callback.status, 303);
    return new URL(location(callback), base);
  }

  let rpcId = 1;
  async function rpc(method, params = {}, token = accessToken) {
    const res = await post(
      "/mcp",
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    );
    assert.equal(res.status, 200, `MCP ${method} answered ${res.status}: ${await res.clone().text()}`);
    const message = await res.json();
    assert.ok(!message.error, `MCP ${method} error: ${JSON.stringify(message.error)}`);
    return message.result;
  }
  const callTool = (name, args) => rpc("tools/call", { name, arguments: args });

  before(async () => {
    const fakePort = await freePort();
    fake = await startFakeEasybill(fakePort);
    const port = await freePort();
    base = `http://localhost:${port}`;
    mcpUrl = `${base}/mcp`;
    dataDir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-hosted-"));

    child = spawn("node", [SERVER_ENTRY, "--http"], {
      env: {
        ...process.env,
        EASYBILL_API_KEY: "",
        PORT: String(port),
        HOST: "127.0.0.1",
        EASYBILL_PUBLIC_URL: base,
        EASYBILL_MCP_SECRET: "test-secret-test-secret-test-secret-1234",
        EASYBILL_DB_PATH: path.join(dataDir, "db.sqlite"),
        EASYBILL_CONNECT_MODE: "oauth",
        EASYBILL_OAUTH_ISSUER: fake.base,
        EASYBILL_BASE_URL: `${fake.base}/rest/v1`,
        EASYBILL_MAX_RETRIES: "0",
        EASYBILL_TENANTS: JSON.stringify({
          tenants: [
            { id: "alpha", name: "Alpha GmbH", plan: "BUSINESS", writes: true, match: { cid: "A" } },
            { id: "beta", name: "Beta AG", plan: "PLUS", match: { cid: "B" } },
          ],
        }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(d.toString()));
    // Wait for the server to listen.
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

  it("registers itself with easybill using the connect callback as redirect URI", () => {
    assert.deepEqual(fake.state.registration.redirect_uris, [`${base}/connect/callback`]);
  });

  it("advertises itself as a protected resource with its own authorization server", async () => {
    const res = await get("/.well-known/oauth-protected-resource/mcp");
    const meta = await res.json();
    assert.equal(meta.resource, mcpUrl);
    assert.deepEqual(meta.authorization_servers, [`${base}/`]);

    const as = await (await get("/.well-known/oauth-authorization-server")).json();
    assert.ok(as.registration_endpoint, "dynamic client registration must be offered (claude.ai needs it)");
  });

  it("rejects unauthenticated MCP calls with a discoverable 401", async () => {
    const res = await post("/mcp", { "Content-Type": "application/json" }, "{}");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=".*oauth-protected-resource\/mcp"/);
  });

  it("sends the person from /authorize to the connect page", async () => {
    const reg = await post(
      "/register",
      { "Content-Type": "application/json" },
      JSON.stringify({
        client_name: "test client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
    assert.equal(reg.status, 201);
    clientId = (await reg.json()).client_id;

    const { challenge, verifier } = pkce();
    codeVerifier = verifier;
    const authorize = new URL("/authorize", base);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "client-state",
      resource: mcpUrl,
    })) {
      authorize.searchParams.set(k, v);
    }
    const res = await fetch(authorize, { redirect: "manual" });
    assert.equal(res.status, 302);
    sessionPath = location(res);
    assert.match(sessionPath, /^\/connect\/[\w-]+$/);

    const page = await (await get(sessionPath)).text();
    assert.match(page, /Alpha GmbH/);
    assert.match(page, /Beta AG/);
    assert.match(page, /Fertig – zurück zu Claude<\/button>/);
    assert.match(page, /disabled>Fertig/, "finish must be disabled while nothing is connected");
  });

  it("refuses to finish before any account is connected", async () => {
    const res = await post(`${sessionPath}/finish`);
    assert.equal(res.status, 303);
    assert.match(location(res), /e=none_connected/);
  });

  it("connects an account through easybill's OAuth and shows who logged in", async () => {
    const back = await connectTenant("alpha", 101);
    assert.equal(back.searchParams.get("n"), "connected");
    assert.equal(fake.state.lastScope.split(" ").includes("customer"), true, "write tenant requests write scopes");
    const page = await (await get(`${back.pathname}${back.search}`)).text();
    assert.match(page, /Verbunden als Erika Muster/);
  });

  it("rejects a login from the wrong company (tenant match)", async () => {
    const back = await connectTenant("beta", 303);
    assert.equal(back.searchParams.get("e"), "wrong_account");
  });

  it("rejects the same easybill login for a second tenant", async () => {
    const back = await connectTenant("beta", 101);
    // match fails first for 101 (company A); either way the login must not be stored under beta
    assert.ok(["duplicate_login", "wrong_account"].includes(back.searchParams.get("e")));
  });

  it("connects a read-only tenant with read-only scopes", async () => {
    const back = await connectTenant("beta", 202);
    assert.equal(back.searchParams.get("n"), "connected");
    assert.ok(fake.state.lastScope.split(" ").every((s) => s.endsWith(".readonly")), fake.state.lastScope);
  });

  it("hands the MCP client an authorization code on finish and exchanges it for tokens", async () => {
    const res = await post(`${sessionPath}/finish`);
    assert.equal(res.status, 303);
    const target = new URL(location(res));
    assert.equal(`${target.origin}${target.pathname}`, redirectUri);
    assert.equal(target.searchParams.get("state"), "client-state");
    grantCookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(grantCookie, /^easybill_mcp_grant=/);

    const token = await post(
      "/token",
      { "Content-Type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        grant_type: "authorization_code",
        code: target.searchParams.get("code"),
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: mcpUrl,
      }),
    );
    assert.equal(token.status, 200, await token.clone().text());
    const body = await token.json();
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
    assert.ok(accessToken && refreshToken);
  });

  it("lists tools with an account argument limited to the connected accounts", async () => {
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const { tools } = await rpc("tools/list");
    const find = tools.find((t) => t.name === "easybill_find_customer");
    assert.deepEqual(find.inputSchema.properties.account.enum.sort(), ["alpha", "beta"]);
    assert.ok(find.inputSchema.required.includes("account"), "account is required with two accounts");
    const listAccounts = tools.find((t) => t.name === "easybill_list_accounts");
    assert.ok(listAccounts && !listAccounts.inputSchema.properties?.account);
    assert.ok(tools.some((t) => t.name === "easybill_create_customer"), "alpha allows writes");
  });

  it("routes each call to the chosen account's easybill token", async () => {
    const a = await callTool("easybill_list_customers", { account: "alpha" });
    assert.ok(!a.isError, JSON.stringify(a));
    assert.match(a.content[0].text, /company A/);
    const b = await callTool("easybill_list_customers", { account: "beta" });
    assert.match(b.content[0].text, /company B/);
    const calls = fake.state.restCalls.filter((c) => c.path === "/customers");
    assert.deepEqual(calls.slice(-2).map((c) => c.login), [101, 202]);
  });

  it("blocks writes on a read-only account", async () => {
    const result = await callTool("easybill_create_customer", { account: "beta", data: { last_name: "X", company_name: "" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /read-only/);
  });

  it("refreshes an easybill token that was revoked early", async () => {
    fake.state.access.clear(); // easybill now answers 401 to every current access token
    const before = fake.state.refreshCount;
    const result = await callTool("easybill_list_customers", { account: "alpha" });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(fake.state.refreshCount, before + 1);
  });

  it("asks for a reconnect when the easybill refresh token is dead", async () => {
    fake.state.access.clear();
    fake.state.refresh.clear();
    const result = await callTool("easybill_list_customers", { account: "beta" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /easybill_list_accounts/);

    const accounts = await callTool("easybill_list_accounts", {});
    const beta = accounts.structuredContent.accounts.find((a) => a.account === "beta");
    assert.equal(beta.status, "expired");
    const manage = new URL(accounts.structuredContent.connect_url);
    const page = await (await get(manage.pathname)).text();
    assert.match(page, /Verbindung abgelaufen/);
    assert.doesNotMatch(page, /zurück zu Claude/, "manage links do not complete an authorization");
  });

  it("rotates its own refresh tokens", async () => {
    const refresh = (token) =>
      post(
        "/token",
        { "Content-Type": "application/x-www-form-urlencoded" },
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId }),
      );
    const first = await refresh(refreshToken);
    assert.equal(first.status, 200);
    const reused = await refresh(refreshToken);
    assert.equal(reused.status, 400, "a used refresh token must not work twice");
    accessToken = (await first.json()).access_token;
    const { tools } = await rpc("tools/list");
    assert.ok(tools.length > 0);
  });

  it("remembers the person's accounts when the MCP client re-authorizes", async () => {
    const { challenge } = pkce();
    const authorize = new URL("/authorize", base);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) {
      authorize.searchParams.set(k, v);
    }
    const res = await fetch(authorize, { redirect: "manual", headers: { Cookie: grantCookie } });
    const page = await (await get(location(res))).text();
    assert.match(page, /Verbunden als Erika Muster/);
  });
});
