/**
 * HTTP client behaviour against a mock easybill API: auth headers, query
 * serialisation, 429 retries, error mapping, binary downloads.
 *
 * Uses a fresh module import per test file so EASYBILL_BASE_URL is picked up —
 * constants are read once at module load.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";

let server;
let client;
let formatApiError;
let EasybillApiError;
let requests = [];
let flakyAttempts = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, headers: req.headers });
    const { pathname } = new URL(req.url, "http://localhost");

    // Fails twice with 429 + Retry-After, then succeeds.
    if (pathname === "/rest/v1/flaky") {
      flakyAttempts++;
      if (flakyAttempts <= 2) {
        res.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Too Many Requests" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, attempts: flakyAttempts }));
      return;
    }

    if (pathname === "/rest/v1/boom") {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Validation failed", errors: { number: ["is required"] } }));
      return;
    }

    if (pathname === "/rest/v1/binary") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="rechnung 42.pdf"',
      });
      res.end(Buffer.from("%PDF-1.4 fake"));
      return;
    }

    if (pathname === "/rest/v1/empty") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ page: 1, pages: 1, limit: 25, total: 0, items: [] }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  process.env.EASYBILL_BASE_URL = `http://127.0.0.1:${port}/rest/v1`;
  process.env.EASYBILL_RATE_LIMIT_PER_MINUTE = "60";
  process.env.EASYBILL_MAX_RETRIES = "3";

  const mod = await import("../dist/services/client.js");
  formatApiError = mod.formatApiError;
  EasybillApiError = mod.EasybillApiError;
  client = new mod.EasybillClient("test-key-123");
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

describe("authentication and query serialisation", () => {
  it("sends a Bearer token and a descriptive User-Agent", async () => {
    await client.request("/documents");
    const last = requests.at(-1);
    assert.equal(last.headers.authorization, "Bearer test-key-123");
    assert.match(last.headers["user-agent"], /easybill-mcp-server/);
  });

  it("joins array filter values with commas and drops empty ones", async () => {
    await client.request("/documents", {
      query: {
        limit: 25,
        type: "INVOICE",
        customer_id: [1, 2, 3],
        empty: "",
        nothing: undefined,
        zero: 0,
      },
    });
    const params = new URL(requests.at(-1).url, "http://x").searchParams;
    assert.equal(params.get("customer_id"), "1,2,3");
    assert.equal(params.get("empty"), null);
    assert.equal(params.get("nothing"), null);
    assert.equal(params.get("zero"), "0", "zero must not be treated as empty");
  });
});

describe("retries", () => {
  it("retries a 429 until success, honouring Retry-After", async () => {
    const started = Date.now();
    const result = await client.request("/flaky");
    assert.equal(result.attempts, 3);
    assert.ok(Date.now() - started >= 2000, "waited for two Retry-After: 1 hints");
  });
});

describe("error mapping", () => {
  it("extracts nested field errors into an actionable message", async () => {
    await assert.rejects(
      () => client.request("/boom"),
      (error) => {
        assert.ok(error instanceof EasybillApiError);
        assert.equal(error.status, 422);
        const message = formatApiError(error);
        assert.match(message, /validation failed \(422\)/);
        assert.match(message, /number: is required/);
        return true;
      },
    );
  });

  it("names the fix in a 429 message", () => {
    const message = formatApiError(
      new EasybillApiError(429, "Too Many Requests", "/documents", "", 30),
    );
    assert.match(message, /Retry in 30s/);
    assert.match(message, /EASYBILL_RATE_LIMIT_PER_MINUTE/);
  });

  it("points at the API key for a 401", () => {
    const message = formatApiError(new EasybillApiError(401, "Unauthorized", "/documents", ""));
    assert.match(message, /EASYBILL_API_KEY/);
  });
});

describe("response handling", () => {
  it("returns buffer, content type and filename for binary downloads", async () => {
    const binary = await client.requestBinary("/binary");
    assert.equal(binary.contentType, "application/pdf");
    assert.equal(binary.fileName, "rechnung 42.pdf");
    assert.equal(binary.data.subarray(0, 5).toString(), "%PDF-");
  });

  it("resolves 204 No Content to undefined", async () => {
    assert.equal(await client.request("/empty"), undefined);
  });
});
