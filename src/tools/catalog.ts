/** Article catalogue: positions (products/services) and their stock movements. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUMMARY_FIELDS } from "../constants.js";
import { multiFilter } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
import { registerCrudTools } from "./crud.js";

const POSITION_BODY_HINT = `Required: number, description, sale_price.

IMPORTANT: prices are INTEGERS IN CENTS — 1999 means 19.99 EUR. Never send decimal euros.

Key fields:
- number (string): article number, must be unique.
- description (string): article name shown on documents.
- sale_price (integer, CENTS): the price. Interpreted as net or gross per 'price_type'.
- price_type ('NETTO'|'BRUTTO'): whether sale_price is net or gross. Default 'NETTO'.
- vat_percent (number): VAT rate, default 19.
- cost_price (integer, CENTS): purchase price, for margin reporting.
- type ('PRODUCT'|'SERVICE'|'TEXT'): default 'PRODUCT'.
- unit (string): e.g. 'Stk.', 'h', 'm'.
- sale_price2 ... sale_price10 (integer, CENTS): tiered prices matching a customer's sale_price_level.
- stock ('YES'|'NO'): enable stock management for this article. Default 'NO'.
- stock_count (number): current stock level. Adjust it via easybill_create_stock, not here.
- stock_limit (number), stock_limit_notify (boolean): low-stock alerting.
- group_id (integer): position group.
- note, document_note (string): internal note vs. text printed on documents.
- archived (boolean).`;

export function registerCatalogTools(server: McpServer, client: ApiClient): void {
  registerCrudTools(server, client, {
    singular: "position",
    plural: "positions",
    nameSingular: "position",
    namePlural: "positions",
    path: "/positions",
    defaultFields: SUMMARY_FIELDS.position,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes:
      "Positions are the reusable article catalogue (products, services and text blocks). " +
      "Referencing one by 'position_id' in a document line item copies its price and description over.\n" +
      "Prices are integers in cents (1999 = 19.99 EUR).",
    bodyHint: POSITION_BODY_HINT,
    deleteNotes: "Documents that already reference this article keep their own copy of its data.",
    filters: {
      number: multiFilter("Filter by exact article number."),
      type: z
        .enum(["PRODUCT", "SERVICE", "TEXT"])
        .optional()
        .describe("Filter by article type."),
    },
  });

  registerCrudTools(server, client, {
    singular: "stock entry",
    plural: "stock entries",
    nameSingular: "stock_entry",
    namePlural: "stock_entries",
    path: "/stocks",
    defaultFields: SUMMARY_FIELDS.stock,
    operations: ["list", "get", "create"],
    listNotes:
      "Stock entries are the inventory movement log for articles that have stock management " +
      "enabled (position.stock = 'YES'). Each entry records a new absolute stock level.\n" +
      "Filter by position_id to see one article's history.",
    bodyHint: `Required: position_id and stock_count.

- position_id (integer): the article to adjust. It must have stock management enabled.
- stock_count (number): the NEW absolute stock level, not a delta.
- note (string): reason for the adjustment, e.g. 'Inventur 2026' or 'Wareneingang LS-4711'.
- stored_at (string): date of the movement, YYYY-MM-DD. Defaults to now.

Stock entries are an append-only audit log — create a new entry to correct a level
rather than editing history.`,
    filters: {
      position_id: multiFilter("Filter by article (position) ID."),
      document_id: multiFilter("Filter by the document that triggered the movement."),
    },
  });
}
