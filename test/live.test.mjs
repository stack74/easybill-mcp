/**
 * Optional end-to-end tests against a real easybill account.
 *
 * Skipped unless EASYBILL_API_KEY is set to a working key, so `npm test` stays
 * offline and safe by default. Read-only throughout — nothing here writes.
 *
 * Run with:  node --env-file=.env --test test/live.test.mjs
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startServer } from "./helpers/mcp-client.mjs";

const KEY = process.env.EASYBILL_API_KEY;
// The offline suites inject this placeholder; treat it as "no key".
const HAS_KEY = Boolean(KEY) && KEY !== "test-key-not-valid";

describe("live easybill account (read-only)", { skip: !HAS_KEY && "EASYBILL_API_KEY not set" }, () => {
  it("lists invoices with working pagination metadata", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      const { result } = await server.callTool("easybill_list_documents", {
        limit: 3,
        type: "INVOICE",
        response_format: "json",
      });
      assert.ok(!result.isError, result.content[0].text);
      const { structuredContent: data } = result;
      assert.equal(typeof data.total, "number");
      assert.ok(data.items.length <= 3);
      assert.equal(data.count, data.items.length);
    } finally {
      server.stop();
    }
  });

  it("returns summary fields that actually exist on live records", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      const { result } = await server.callTool("easybill_list_documents", {
        limit: 1,
        type: "INVOICE",
        response_format: "json",
      });
      const item = result.structuredContent.items[0];
      if (!item) return; // empty account — nothing to assert
      // A stale field list would show up as undefined values or a near-empty record.
      assert.ok(Object.keys(item).length >= 5, `only got ${Object.keys(item).length} fields`);
      assert.ok(!Object.values(item).includes(undefined));
      assert.ok("id" in item && "number" in item);
    } finally {
      server.stop();
    }
  });

  it("returns the full record for a single document, including line items", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      const list = await server.callTool("easybill_list_documents", {
        limit: 1,
        type: "INVOICE",
        response_format: "json",
      });
      const first = list.result.structuredContent.items[0];
      if (!first) return;

      const { result } = await server.callTool("easybill_get_document", {
        id: first.id,
        response_format: "json",
      });
      const doc = result.structuredContent;
      // Detail views must not apply the compact summary filter.
      assert.ok(Object.keys(doc).length > 20, `get returned only ${Object.keys(doc).length} fields`);
      assert.ok(Array.isArray(doc.items), "a document should carry its line items");
    } finally {
      server.stop();
    }
  });

  it("narrows the response when 'fields' is given", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      const { result } = await server.callTool("easybill_list_documents", {
        limit: 1,
        type: "INVOICE",
        fields: ["number", "amount"],
        response_format: "json",
      });
      const item = result.structuredContent.items[0];
      if (!item) return;
      assert.deepEqual(Object.keys(item).sort(), ["amount", "id", "number"]);
    } finally {
      server.stop();
    }
  });

  it("finds nothing for a nonsense customer query, and says what to do next", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      const { result } = await server.callTool("easybill_find_customer", {
        query: "Zzz Nonexistent Company Qqq",
        response_format: "json",
      });
      assert.equal(result.structuredContent.match_count, 0);
      assert.match(result.content[0].text, /easybill_create_customer/);
    } finally {
      server.stop();
    }
  });

  it("finds a real customer through legal-form and punctuation noise", async () => {
    const server = await startServer({ env: { EASYBILL_API_KEY: KEY } });
    try {
      // Take a real customer, then search for it with the legal form mangled.
      const list = await server.callTool("easybill_list_customers", {
        limit: 1,
        response_format: "json",
      });
      const customer = list.result.structuredContent.items[0];
      if (!customer) return;

      const name = String(customer.company_name ?? customer.display_name ?? "");
      if (name.length < 4) return;
      // Strip punctuation and legal suffixes — exact filtering would miss this.
      const mangled = name.replace(/[.,]/g, "").replace(/\s*(GmbH|AG|KG|Co\.?)\s*/gi, " ").trim();
      if (mangled.length < 3) return;

      const { result } = await server.callTool("easybill_find_customer", {
        query: mangled,
        response_format: "json",
      });
      assert.ok(
        result.structuredContent.match_count > 0,
        `fuzzy search failed to find "${name}" via "${mangled}"`,
      );
      assert.ok(
        result.structuredContent.candidates.some((c) => c.id === customer.id),
        "the known customer should be among the candidates",
      );
    } finally {
      server.stop();
    }
  });
});
