/**
 * The client-side throttle.
 *
 * easybill allows only 10 req/min on PLUS, so the server must queue excess calls
 * rather than let them hit the API. This runs against a fresh client so the
 * sliding window starts empty.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";

const BURST = 4;
let server;
let client;
let hits = [];

before(async () => {
  server = http.createServer((_req, res) => {
    hits.push(Date.now());
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  process.env.EASYBILL_BASE_URL = `http://127.0.0.1:${port}/rest/v1`;
  process.env.EASYBILL_RATE_LIMIT_PER_MINUTE = String(BURST);
  process.env.EASYBILL_MAX_RETRIES = "0";

  const { EasybillClient } = await import("../dist/services/client.js");
  client = new EasybillClient("k");
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

describe("sliding-window throttle", () => {
  it(`allows exactly ${BURST} requests immediately and queues the rest`, async () => {
    // Fire more than the limit at once; the excess must wait for the window to roll.
    const inflight = Array.from({ length: BURST + 2 }, () => client.request("/ping"));

    let settled = 0;
    for (const promise of inflight) promise.then(() => settled++, () => settled++);

    await new Promise((resolve) => setTimeout(resolve, 600));

    assert.equal(hits.length, BURST, `expected ${BURST} immediate requests, got ${hits.length}`);
    assert.equal(settled, BURST, "the excess calls must still be pending");
    assert.ok(hits[BURST - 1] - hits[0] < 500, "the allowed burst is not artificially serialised");
  });
});
