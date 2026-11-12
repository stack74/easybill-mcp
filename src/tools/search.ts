/**
 * Fuzzy customer lookup.
 *
 * The easybill API offers no full-text search — its customer filters match exact
 * values only. That makes "is this company already a customer?" surprisingly hard,
 * which is the first question to answer when processing an inbound inquiry.
 *
 * This tool bridges the gap: it tries cheap exact filters first, then falls back to
 * paging the customer list and scoring candidates locally.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUMMARY_FIELDS } from "../constants.js";
import { responseFormatSchema } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
import {
  type EasybillList,
  type Record_,
  type ResponseFormat,
  type ToolResult,
  selectFields,
} from "../services/format.js";
import { registerRead } from "./registry.js";

/** Legal-form and filler tokens that carry no identifying weight. */
const NOISE_TOKENS = new Set([
  "gmbh", "co", "kg", "ag", "ohg", "gbr", "ug", "ek", "e", "k", "mbh", "kgaa",
  "and", "und", "the", "der", "die", "das", "haftungsbeschraenkt",
  "ltd", "llc", "inc", "bv", "nv", "sa", "srl", "spa", "as", "ab", "oy", "aps",
]);

/** Lowercase, strip punctuation, split into meaningful tokens. */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[c] ?? c)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !NOISE_TOKENS.has(t));
}

/** Fields on a customer record worth matching a query against. */
const SEARCHABLE = [
  "company_name",
  "display_name",
  "last_name",
  "first_name",
  "number",
  "city",
  "street",
  "zip_code",
  "vat_identifier",
] as const;

/** Builds the haystack string for a customer, including its email addresses. */
function haystack(customer: Record_): string {
  const parts: string[] = [];
  for (const key of SEARCHABLE) {
    const value = customer[key];
    if (typeof value === "string" && value !== "") parts.push(value);
  }
  const emails = customer.emails;
  if (Array.isArray(emails)) parts.push(...emails.filter((e): e is string => typeof e === "string"));
  else if (typeof emails === "string") parts.push(emails);
  return parts.join(" ");
}

/**
 * Scores a customer against the query tokens.
 * 1.0 = every query token appears; 0 = nothing matches.
 */
function score(customer: Record_, queryTokens: string[], rawQuery: string): number {
  const hay = haystack(customer);
  const hayLower = hay.toLowerCase();

  // A full substring hit is the strongest signal.
  if (rawQuery.length >= 3 && hayLower.includes(rawQuery.toLowerCase())) return 1;

  const hayTokens = new Set(tokenize(hay));
  if (queryTokens.length === 0 || hayTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    // Exact token match, or a token that starts with the query token (≥4 chars).
    if (hayTokens.has(token)) hits++;
    else if (token.length >= 4 && [...hayTokens].some((h) => h.startsWith(token))) hits += 0.8;
  }
  return hits / queryTokens.length;
}

export function registerSearchTools(server: McpServer, client: ApiClient): void {
  registerRead(
    server,
    {
      name: "easybill_find_customer",
      title: "Find a customer by name, email or number (fuzzy)",
      description: `Search for an existing customer by company name, person name, email, customer number or city.

USE THIS FIRST whenever you need to know whether someone is already a customer — for example
before creating an offer or invoice from an inbound inquiry. The easybill API has no full-text
search, so this tool combines exact filters with a local fuzzy match over the customer list.

It tolerates the differences that break exact matching: legal forms ('GmbH & Co. KG'),
punctuation ('M.B. MUSTERMANN' vs 'MB Mustermann'), umlauts, and word order.

Args:
  - query (string): what to search for. A company name, surname, email or customer number.
  - limit (number): max candidates to return, 1-25 (default 5).
  - min_score (number): 0-1 match threshold (default 0.5). Lower it to cast a wider net.
  - max_pages (number): how many pages of 1000 customers to scan in the fallback (default 3).
    Each page is one API request, so keep this low on a plan with a 10 req/min limit.

Returns: { query, match_count, exact_match (boolean), candidates[] } where each candidate has
its easybill 'id', 'match_score' (1 = certain) and the usual summary fields.

Next steps based on the result:
  - Exactly one strong candidate (score 1) -> use its 'id' as customer_id.
  - Several candidates -> show them to the user and ask which one, do NOT guess.
  - No candidates -> the customer does not exist yet. Create it with easybill_create_customer,
    then use the returned 'id'.

Examples:
  - "Is Mustermann Handels GmbH & Co. KG already a customer?" -> query="Mustermann Handels GmbH & Co. KG"
  - "Find the customer with email einkauf@example.com" -> query="einkauf@example.com"
  - "Look up customer number 10023" -> query="10023"`,
      inputSchema: {
        query: z
          .string()
          .min(2, "Query must be at least 2 characters")
          .max(200)
          .describe("Company name, person name, email address, customer number or city."),
        limit: z.number().int().min(1).max(25).default(5).describe("Max candidates to return."),
        min_score: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe("Minimum match score, 0-1. Lower for a wider net."),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe("Pages of 1000 customers to scan in the fuzzy fallback. Each costs 1 request."),
        response_format: responseFormatSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      const query = (args.query as string).trim();
      const limit = args.limit as number;
      const minScore = args.min_score as number;
      const maxPages = args.max_pages as number;
      const format = (args.response_format as ResponseFormat | undefined) ?? "markdown";

      const queryTokens = tokenize(query);
      const looksLikeEmail = query.includes("@");
      const looksLikeNumber = /^\d+$/.test(query);

      // --- Phase 1: cheap exact filters (1 request each, only where plausible) ---
      const exactAttempts: { field: string; value: string }[] = [];
      if (looksLikeEmail) exactAttempts.push({ field: "emails", value: query });
      else if (looksLikeNumber) exactAttempts.push({ field: "number", value: query });
      else exactAttempts.push({ field: "company_name", value: query });

      for (const attempt of exactAttempts) {
        const hit = await client.request<EasybillList<Record_>>("/customers", {
          query: { [attempt.field]: attempt.value, limit: limit },
        });
        const items = hit?.items ?? [];
        if (items.length > 0) {
          const candidates = items.slice(0, limit).map((c) => ({
            ...selectFields(c, SUMMARY_FIELDS.customer),
            match_score: 1,
            matched_by: `exact ${attempt.field}`,
          }));
          return render(query, candidates, true, format, `exact match on ${attempt.field}`);
        }
      }

      // --- Phase 2: page the list and score locally ---
      const scored: { customer: Record_; value: number }[] = [];
      let pagesScanned = 0;
      let totalCustomers = 0;

      for (let page = 1; page <= maxPages; page++) {
        const list = await client.request<EasybillList<Record_>>("/customers", {
          query: { limit: 1000, page },
        });
        pagesScanned++;
        totalCustomers = list?.total ?? 0;
        for (const customer of list?.items ?? []) {
          const value = score(customer, queryTokens, query);
          if (value >= minScore) scored.push({ customer, value });
        }
        if (page >= (list?.pages ?? 1)) break;
      }

      scored.sort((a, b) => b.value - a.value);
      const candidates = scored.slice(0, limit).map(({ customer, value }) => ({
        ...selectFields(customer, SUMMARY_FIELDS.customer),
        match_score: Math.round(value * 100) / 100,
        matched_by: "fuzzy",
      }));

      const scanNote =
        `scanned ${pagesScanned} page(s), ${totalCustomers} customers total` +
        (pagesScanned * 1000 < totalCustomers
          ? ` — NOT all customers were scanned, raise 'max_pages' to widen the search`
          : "");

      return render(query, candidates, false, format, scanNote);
    },
  );
}

/** Shared rendering for both search phases. */
function render(
  query: string,
  candidates: Record_[],
  exact: boolean,
  format: ResponseFormat,
  note: string,
): ToolResult {
  const output: Record_ = {
    query,
    match_count: candidates.length,
    exact_match: exact,
    search_note: note,
    candidates,
  };

  if (candidates.length === 0) {
    const text =
      `No customer found matching "${query}" (${note}).\n\n` +
      `This customer most likely does not exist in easybill yet. ` +
      `To proceed, create it with easybill_create_customer (required: last_name AND company_name — ` +
      `send an empty string for whichever does not apply), then use the returned 'id' as customer_id.\n\n` +
      `If you expected a match, try a shorter query (just the distinctive word), or lower 'min_score'.`;
    return { content: [{ type: "text", text }], structuredContent: output };
  }

  if (format === "json") {
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  }

  const lines = [
    `# Customer search: "${query}"`,
    "",
    `${candidates.length} candidate(s) — ${note}`,
    "",
  ];
  for (const c of candidates) {
    const label = c.display_name ?? c.company_name ?? `${String(c.last_name ?? "")}`.trim();
    lines.push(`## ${String(label || "(unnamed)")} — id ${String(c.id)} (score ${String(c.match_score)})`);
    for (const key of ["number", "company_name", "first_name", "last_name", "emails", "street", "zip_code", "city", "country"]) {
      const value = c[key];
      if (value === undefined || value === null || value === "") continue;
      lines.push(`- **${key}**: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
    lines.push("");
  }

  if (candidates.length > 1) {
    lines.push(
      "> Several customers matched. Confirm which one is meant before creating a document — do not guess.",
    );
  } else if (candidates[0]?.match_score !== 1) {
    lines.push(
      "> This is a fuzzy match, not a certain one. Verify it is the right customer before using its id.",
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: output };
}
