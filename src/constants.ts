/** Shared constants and runtime configuration for the easybill MCP server. */

import { createRequire } from "node:module";

/** Overridable so the server can be pointed at a proxy or a test double. */
export const API_BASE_URL = (
  process.env.EASYBILL_BASE_URL?.trim() || "https://api.easybill.de/rest/v1"
).replace(/\/+$/, "");

export const SERVER_NAME = "easybill-mcp-server";

/**
 * Read from package.json rather than duplicated here, so `--version`, the MCP
 * serverInfo and the published package can never disagree.
 */
export const SERVER_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    // dist/constants.js -> ../package.json
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function intFromEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

/** Maximum characters in a single tool response before it gets truncated. */
export const CHARACTER_LIMIT = intFromEnv("EASYBILL_CHARACTER_LIMIT", 25_000, 1_000);

/** HTTP request timeout. */
export const TIMEOUT_MS = intFromEnv("EASYBILL_TIMEOUT_MS", 30_000, 1_000);

/**
 * Client-side throttle. easybill allows 10 req/min (Professional) and 60 req/min (Premium).
 * Throttling locally is cheaper than burning retries on HTTP 429.
 */
export const RATE_LIMIT_PER_MINUTE = intFromEnv("EASYBILL_RATE_LIMIT_PER_MINUTE", 60, 1);

/** Retries for a 429 / transient network failure. */
export const MAX_RETRIES = intFromEnv("EASYBILL_MAX_RETRIES", 3, 0);

/** Create/update/delete tools are only registered when this is explicitly enabled. */
export const WRITES_ENABLED = /^(1|true|yes)$/i.test(process.env.EASYBILL_ENABLE_WRITES ?? "");

/**
 * easybill expects and returns all dates in Europe/Berlin.
 * date     = Y-m-d           e.g. 2016-12-31
 * datetime = Y-m-d H:i:s     e.g. 2016-12-31 03:13:37
 */
export const DATE_HINT = "Format YYYY-MM-DD (timezone Europe/Berlin)";
export const DATE_RANGE_HINT =
  "Single date 'YYYY-MM-DD' or an inclusive range 'YYYY-MM-DD,YYYY-MM-DD'";

/** Document types used across the documents API. */
export const DOCUMENT_TYPES = [
  "INVOICE",
  "RECURRING",
  "CREDIT",
  "OFFER",
  "REMINDER",
  "DUNNING",
  "STORNO",
  "STORNO_CREDIT",
  "DELIVERY",
  "PDF",
  "CHARGE",
  "CHARGE_CONFIRM",
  "LETTER",
  "ORDER",
  "PROFORMA_INVOICE",
  "STORNO_PROFORMA_INVOICE",
] as const;

/** Types an existing document can be converted into. */
export const CONVERTIBLE_TYPES = [
  "DUNNING",
  "REMINDER",
  "CHARGE_CONFIRM",
  "CHARGE",
  "CREDIT",
  "DELIVERY",
  "INVOICE",
  "ORDER",
] as const;

/**
 * Compact field sets for list responses. Document has 69 and Customer 79 fields;
 * returning them all for 100 rows floods the agent's context with no benefit.
 * Callers can override with `fields` (explicit list) or `fields: ["all"]`.
 */
export const SUMMARY_FIELDS = {
  document: [
    "id",
    "number",
    "type",
    "status",
    "title",
    "document_date",
    "due_date",
    "customer_id",
    "project_id",
    "amount",
    "amount_net",
    "currency",
    "paid_amount",
    "paid_at",
    "is_draft",
    "is_archive",
    "cancel_id",
  ],
  customer: [
    "id",
    "number",
    "display_name",
    "company_name",
    "first_name",
    "last_name",
    "emails",
    "phone_1",
    "street",
    "zip_code",
    "city",
    "country",
    "group_id",
    "vat_identifier",
    "archived",
  ],
  position: [
    "id",
    "number",
    "type",
    "description",
    "unit",
    "sale_price",
    "cost_price",
    "vat_percent",
    "price_type",
    "group_id",
    "stock",
    "stock_count",
    "archived",
  ],
  contact: [
    "id",
    "company_name",
    "salutation",
    "first_name",
    "last_name",
    "department",
    "emails",
    "phone_1",
    "mobile",
    "street",
    "zip_code",
    "city",
    "country",
  ],
  project: [
    "id",
    "name",
    "customer_id",
    "status",
    "due_at",
    "hourly_rate",
    "budget_amount",
    "budget_time",
    "consumed_amount",
    "consumed_time",
  ],
  payment: [
    "id",
    "document_id",
    "amount",
    "payment_at",
    "type",
    "provider",
    "reference",
    "notice",
    "is_overdue_fee",
    "login_id",
  ],
  timeTracking: [
    "id",
    "number",
    "description",
    "date_from_at",
    "date_thru_at",
    "timer_value",
    "hourly_rate",
    "position_id",
    "project_id",
    "cleared_at",
    "login_id",
  ],
  attachment: ["id", "file_name", "size", "created_at", "document_id", "customer_id", "project_id"],
  task: [
    "id",
    "name",
    "status",
    "status_percent",
    "priority",
    "category",
    "start_at",
    "end_at",
    "finish_at",
    "customer_id",
    "project_id",
    "login_id",
  ],
  stock: [
    "id",
    "position_id",
    "stock_count",
    "note",
    "stored_at",
    "created_at",
    "document_id",
    "document_position_id",
  ],
  textTemplate: ["id", "title", "text", "can_modify"],
  customerGroup: ["id", "number", "name", "display_name", "description"],
  serialNumber: ["id", "serial_number", "position_id", "document_id", "used_at", "created_at"],
  pdfTemplate: ["id", "name", "pdf_template", "document_type"],
  incomingDocument: [
    "id",
    "status",
    "document_type",
    "document_number",
    "external_number",
    "issue_date",
    "due_date",
    "total_gross_amount",
    "total_net_amount",
    "currency_code",
    "is_paid",
    "supplier_id",
    "supplier",
    "interface",
    "created_at",
  ],
} as const;
