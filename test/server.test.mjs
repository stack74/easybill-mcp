/**
 * The MCP surface: what the server advertises over the real wire protocol.
 *
 * These run against dist/index.js with an invalid API key — they assert on schemas,
 * annotations, write-gating and error handling, none of which need live data.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startServer } from "./helpers/mcp-client.mjs";

describe("tool registration", () => {
  it("exposes only read-only tools by default", async () => {
    const server = await startServer();
    try {
      const tools = await server.listTools();
      const writeTools = tools.filter((t) => t.annotations?.readOnlyHint === false);
      assert.equal(writeTools.length, 0, `unexpected write tools: ${writeTools.map((t) => t.name)}`);
      assert.ok(tools.length >= 20, `expected a substantial read-only surface, got ${tools.length}`);
    } finally {
      server.stop();
    }
  });

  it("registers write tools when EASYBILL_ENABLE_WRITES is set", async () => {
    const server = await startServer({ env: { EASYBILL_ENABLE_WRITES: "true" } });
    try {
      const tools = await server.listTools();
      const writeTools = tools.filter((t) => t.annotations?.readOnlyHint === false);
      assert.ok(writeTools.length > 0, "writes enabled but no write tools registered");

      // Deletions must be flagged so clients can prompt appropriately.
      const destructive = tools.filter((t) => t.annotations?.destructiveHint === true);
      assert.ok(
        destructive.some((t) => t.name === "easybill_delete_document"),
        "delete_document must carry destructiveHint",
      );
    } finally {
      server.stop();
    }
  });

  it("gives every tool a title, description and object input schema", async () => {
    const server = await startServer({ env: { EASYBILL_ENABLE_WRITES: "true" } });
    try {
      const tools = await server.listTools();
      const malformed = tools.filter(
        (t) => !t.title || !t.description || t.inputSchema?.type !== "object",
      );
      assert.deepEqual(malformed.map((t) => t.name), []);
    } finally {
      server.stop();
    }
  });

  it("prefixes every tool with easybill_ to avoid collisions with other servers", async () => {
    const server = await startServer({ env: { EASYBILL_ENABLE_WRITES: "true" } });
    try {
      const tools = await server.listTools();
      const unprefixed = tools.filter((t) => !t.name.startsWith("easybill_"));
      assert.deepEqual(unprefixed.map((t) => t.name), []);
    } finally {
      server.stop();
    }
  });
});

describe("workflow guidance", () => {
  it("ships server instructions covering the money and ordering rules", async () => {
    const server = await startServer();
    try {
      const { instructions } = server.initialize;
      assert.ok(instructions, "server must send instructions during initialize");
      for (const marker of [
        "CENTS",
        "easybill_find_customer",
        "easybill_complete_document",
        "read-only mode",
      ]) {
        assert.ok(instructions.includes(marker), `instructions must mention "${marker}"`);
      }
    } finally {
      server.stop();
    }
  });

  it("puts customer lookup ahead of document listing in the tool order", async () => {
    const server = await startServer();
    try {
      const names = (await server.listTools()).map((t) => t.name);
      const find = names.indexOf("easybill_find_customer");
      const list = names.indexOf("easybill_list_documents");
      assert.ok(find >= 0 && list >= 0);
      assert.ok(find < list, "find_customer should be advertised before list_documents");
    } finally {
      server.stop();
    }
  });

  it("states the customer-first sequence in create_document's description", async () => {
    const server = await startServer({ env: { EASYBILL_ENABLE_WRITES: "true" } });
    try {
      const tools = await server.listTools();
      const create = tools.find((t) => t.name === "easybill_create_document");
      assert.match(create.description, /WORKFLOW/);
      assert.match(create.description, /easybill_find_customer/);
      assert.match(create.description, /CENTS/);

      // And the list tool should redirect rather than invite exploration.
      const list = tools.find((t) => t.name === "easybill_list_documents");
      assert.match(list.description, /NOT the right tool/);
    } finally {
      server.stop();
    }
  });
});

describe("input validation", () => {
  // The SDK validates against the Zod schema before the handler runs and reports
  // failures as an isError result (not a JSON-RPC error), so the agent can read
  // and correct them.
  it("rejects a limit above the API maximum", async () => {
    const server = await startServer();
    try {
      const { result } = await server.callTool("easybill_list_customers", { limit: 5000 });
      assert.equal(result.isError, true, "out-of-range limit must be rejected");
      assert.match(result.content[0].text, /validation error/i);
      assert.match(result.content[0].text, /limit/);
    } finally {
      server.stop();
    }
  });

  it("rejects a missing required argument", async () => {
    const server = await startServer();
    try {
      const { result } = await server.callTool("easybill_get_customer", {});
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /validation error/i);
      assert.match(result.content[0].text, /at id/);
    } finally {
      server.stop();
    }
  });

  it("accepts a valid call through to the API layer", async () => {
    // Proves validation is not rejecting well-formed input: this reaches the
    // network and fails on auth instead.
    const server = await startServer({ env: { EASYBILL_MAX_RETRIES: "0" } });
    try {
      const { result } = await server.callTool("easybill_list_customers", { limit: 10 });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /EASYBILL_API_KEY/);
      assert.doesNotMatch(result.content[0].text, /validation error/i);
    } finally {
      server.stop();
    }
  });
});

describe("error handling", () => {
  it("reports an auth failure as a tool error, not a protocol crash", async () => {
    const server = await startServer({ env: { EASYBILL_MAX_RETRIES: "0" } });
    try {
      const response = await server.callTool("easybill_list_documents", { limit: 1 });
      assert.ok(!response.error, "API failures must not surface as JSON-RPC errors");
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /EASYBILL_API_KEY/);
    } finally {
      server.stop();
    }
  });

  it("keeps stdout clean so the protocol stream stays parseable", async () => {
    // startServer throws if any non-JSON line appears on stdout.
    const server = await startServer({ env: { EASYBILL_MAX_RETRIES: "0" } });
    try {
      await server.callTool("easybill_list_documents", { limit: 1 });
      await server.listTools();
      assert.match(server.stderr, /ready on stdio/, "startup log belongs on stderr");
    } finally {
      server.stop();
    }
  });
});

describe("server info", () => {
  it("explains read-only mode and how to enable writes", async () => {
    const server = await startServer({ env: { EASYBILL_MAX_RETRIES: "0" } });
    try {
      const response = await server.callTool("easybill_get_server_info", {
        test_connection: false,
      });
      const { structuredContent, content } = response.result;
      assert.equal(structuredContent.writes_enabled, false);
      assert.ok(structuredContent.tools_registered.withheld_because_writes_disabled > 0);
      assert.match(content[0].text, /EASYBILL_ENABLE_WRITES=true/);
    } finally {
      server.stop();
    }
  });
});
