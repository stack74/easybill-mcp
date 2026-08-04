/**
 * Response shaping: field selection, pagination envelopes, markdown rendering
 * and character-limit truncation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildListResponse,
  buildMutationResponse,
  buildRecordResponse,
  selectFields,
} from "../dist/services/format.js";
import { SUMMARY_FIELDS } from "../dist/constants.js";

const DOC = { id: 7, number: "R-1", amount: 1999, secret: "x", title: "T" };

/** Builds a fake easybill list envelope. */
const makeList = (count, extra = {}) => ({
  page: 1,
  pages: 3,
  limit: count,
  total: 250,
  items: Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    number: `R-${i + 1}`,
    type: "INVOICE",
    amount: (i + 1) * 100,
    title: `Invoice ${i + 1}`,
    paid_at: null,
    ...extra,
  })),
});

describe("selectFields", () => {
  it("uses the default field set when 'fields' is omitted", () => {
    const result = selectFields(DOC, ["id", "number", "amount"]);
    assert.deepEqual(Object.keys(result).sort(), ["amount", "id", "number"]);
  });

  it("returns the untouched record for ['all']", () => {
    assert.deepEqual(selectFields(DOC, ["id"], ["all"]), DOC);
  });

  it("always keeps 'id' so results stay addressable", () => {
    const result = selectFields(DOC, ["id"], ["title"]);
    assert.deepEqual(Object.keys(result).sort(), ["id", "title"]);
  });

  it("falls back to the full record when the selection matches nothing", () => {
    // Guards against a stale field list silently blanking out a response.
    assert.deepEqual(selectFields({ a: 1, b: 2 }, ["nope", "alsonope"]), { a: 1, b: 2 });
  });
});

describe("buildListResponse", () => {
  it("reports pagination metadata", () => {
    const { structuredContent } = buildListResponse({
      list: makeList(5),
      resource: "documents",
      defaultFields: SUMMARY_FIELDS.document,
      format: "json",
    });
    assert.equal(structuredContent.total, 250);
    assert.equal(structuredContent.count, 5);
    assert.equal(structuredContent.page, 1);
    assert.equal(structuredContent.pages, 3);
    assert.equal(structuredContent.has_more, true);
    assert.equal(structuredContent.next_page, 2);
  });

  it("omits next_page on the last page", () => {
    const { structuredContent } = buildListResponse({
      list: { ...makeList(5), page: 3, pages: 3 },
      resource: "documents",
      defaultFields: SUMMARY_FIELDS.document,
      format: "json",
    });
    assert.equal(structuredContent.has_more, false);
    assert.equal(structuredContent.next_page, undefined);
  });

  it("returns guidance instead of an empty array, echoing the filters", () => {
    const result = buildListResponse({
      list: { page: 1, pages: 0, limit: 25, total: 0, items: [] },
      resource: "documents",
      defaultFields: SUMMARY_FIELDS.document,
      format: "markdown",
      filters: { type: "INVOICE", paid_at: "null" },
    });
    assert.match(result.content[0].text, /No documents found/);
    assert.match(result.content[0].text, /type=INVOICE/);
  });

  it("shrinks the payload when 'fields' narrows the columns", () => {
    const common = {
      resource: "documents",
      defaultFields: SUMMARY_FIELDS.document,
      format: "json",
    };
    const full = buildListResponse({ ...common, list: makeList(10), fields: ["all"] });
    const slim = buildListResponse({ ...common, list: makeList(10), fields: ["number"] });

    assert.ok(slim.content[0].text.length < full.content[0].text.length);
    assert.deepEqual(Object.keys(slim.structuredContent.items[0]).sort(), ["id", "number"]);
  });

  it("truncates oversized responses but keeps pagination metadata", () => {
    const { structuredContent, content } = buildListResponse({
      // A big blob per item pushes the payload past CHARACTER_LIMIT.
      list: makeList(200, { text: "L".repeat(2000) }),
      resource: "documents",
      defaultFields: ["id", "number", "text"],
      format: "json",
    });

    assert.equal(structuredContent.truncated, true);
    assert.ok(structuredContent.items.length < 200);
    assert.match(structuredContent.truncation_message, /smaller 'limit'|filters|'fields'/);
    assert.ok(content[0].text.length <= 25_000 * 1.05);
    assert.equal(structuredContent.total, 250, "total survives truncation");
    assert.equal(structuredContent.has_more, true);
  });

  it("renders markdown with labels, joined arrays, dashes for null and yes/no", () => {
    const { content } = buildListResponse({
      list: {
        page: 1,
        pages: 1,
        limit: 1,
        total: 1,
        items: [
          {
            id: 9,
            display_name: "ACME GmbH",
            emails: ["a@b.de", "c@d.de"],
            city: null,
            archived: false,
          },
        ],
      },
      resource: "customers",
      defaultFields: SUMMARY_FIELDS.customer,
      format: "markdown",
    });

    assert.match(content[0].text, /## ACME GmbH \(id 9\)/);
    assert.match(content[0].text, /a@b\.de, c@d\.de/);
    assert.match(content[0].text, /\*\*city\*\*: –/);
    assert.match(content[0].text, /\*\*archived\*\*: no/);
  });
});

describe("buildRecordResponse", () => {
  it("returns every field by default, so get-by-id hides nothing", () => {
    const { structuredContent } = buildRecordResponse({
      record: DOC,
      resource: "document",
      defaultFields: ["id", "number"],
      format: "json",
    });
    assert.deepEqual(structuredContent, DOC);
  });

  it("respects an explicit field selection", () => {
    const { structuredContent } = buildRecordResponse({
      record: DOC,
      resource: "document",
      defaultFields: ["id", "number"],
      format: "json",
      fields: ["amount"],
    });
    assert.deepEqual(Object.keys(structuredContent).sort(), ["amount", "id"]);
  });

  it("reports a missing record clearly", () => {
    const result = buildRecordResponse({
      record: undefined,
      resource: "document",
      defaultFields: ["id"],
      format: "json",
    });
    assert.match(result.content[0].text, /No document returned/);
  });
});

describe("buildMutationResponse", () => {
  it("confirms the action and echoes the record", () => {
    const result = buildMutationResponse(
      "Created",
      "document",
      { id: 42, number: "R-42", amount: 1999 },
      "markdown",
      SUMMARY_FIELDS.document,
    );
    assert.match(result.content[0].text, /Created document R-42 \(id 42\)/);
    assert.equal(result.structuredContent.document.id, 42);
  });

  it("still confirms success when the API returns no body", () => {
    const result = buildMutationResponse("Completed", "document", undefined, "json", ["id"]);
    assert.match(result.content[0].text, /Completed document succeeded/);
  });
});
