/**
 * Local (stdio) mode against a mock easybill: files go to and come from local
 * paths, and find_customer falls back to exact filters + a local scan when the
 * full-text search endpoint is unavailable.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startMockApi, startServer } from "./helpers/mcp-client.mjs";

describe("stdio mode: local files and search fallback", () => {
  let api;
  let server;
  let dir;
  let upload;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "easybill-mcp-stdio-"));
    api = await startMockApi(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url, "http://x");
      const json = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/rest/v1/customers/search") return json(404, { message: "not found" });
      if (url.pathname === "/rest/v1/customers") {
        if (url.searchParams.get("company_name")) return json(200, { page: 1, pages: 1, limit: 5, total: 0, items: [] });
        return json(200, {
          page: 1,
          pages: 1,
          limit: 1000,
          total: 2,
          items: [
            { id: 1, company_name: "Anders GmbH" },
            { id: 2, company_name: "Mustermann Handels GmbH & Co. KG" },
          ],
        });
      }
      if (url.pathname === "/rest/v1/documents/7/pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return res.end("%PDF-1.4 local");
      }
      if (url.pathname === "/rest/v1/incoming-documents" && req.method === "POST") {
        upload = Buffer.concat(chunks).toString("latin1");
        return json(201, { id: "0f8fad5b-d9cb-469f-a165-70867728950e", status: "PREPARING" });
      }
      json(404, { message: "not found" });
    });
    server = await startServer({
      env: { EASYBILL_BASE_URL: api.baseUrl, EASYBILL_ENABLE_WRITES: "true", EASYBILL_MAX_RETRIES: "0" },
    });
  });

  after(() => {
    server?.stop();
    api?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to exact filters and a local scan when full-text search is unavailable", async () => {
    const { result } = await server.callTool("easybill_find_customer", { query: "Mustermann Handels" });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.structuredContent.candidates[0].id, 2);
    assert.equal(result.structuredContent.candidates[0].matched_by, "fuzzy");
  });

  it("saves a downloaded document to the given local path", async () => {
    const target = path.join(dir, "invoice.pdf");
    const { result } = await server.callTool("easybill_download_document", { id: 7, output_path: target });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(readFileSync(target, "utf8"), "%PDF-1.4 local");
    assert.equal(result.structuredContent.saved_to, target);
  });

  it("uploads an incoming document from a local file", async () => {
    const source = path.join(dir, "beleg.pdf");
    writeFileSync(source, "%PDF-1.4 beleg");
    const { result } = await server.callTool("easybill_upload_incoming_document", { file_path: source });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(upload, /filename="beleg\.pdf"/);
    assert.match(upload, /%PDF-1\.4 beleg/);
  });
});
