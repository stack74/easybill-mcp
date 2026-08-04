/**
 * Shared response shaping: field selection, pagination envelopes,
 * markdown rendering and character-limit truncation.
 *
 * All list tools funnel through `buildListResponse` and all single-record
 * tools through `buildRecordResponse`, so formatting stays consistent.
 */

import { CHARACTER_LIMIT } from "../constants.js";

export const RESPONSE_FORMATS = ["markdown", "json"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** The pagination envelope easybill wraps every list resource in. */
export interface EasybillList<T> {
  page: number;
  pages: number;
  limit: number;
  total: number;
  items: T[];
}

export type Record_ = Record<string, unknown>;

/** An MCP tool result. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record_;
  isError?: boolean;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Reduces a record to the requested fields.
 * - `fields` omitted  -> `defaults` (compact summary)
 * - `["all"]`         -> untouched record
 * - explicit list     -> exactly those keys, plus `id` so results stay addressable
 *
 * Falls back to the full record if the selection matches nothing, so a stale
 * field list can never silently blank out a response.
 */
export function selectFields(
  record: Record_,
  defaults: readonly string[],
  fields?: string[],
): Record_ {
  if (fields?.includes("all")) return record;
  const wanted = fields && fields.length > 0 ? ["id", ...fields] : defaults;

  const result: Record_ = {};
  for (const key of wanted) {
    if (key in record) result[key] = record[key];
  }
  return Object.keys(result).length > 0 ? result : record;
}

/** Formats a value for markdown output. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "–";
  if (Array.isArray(value)) {
    if (value.length === 0) return "–";
    return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Picks the most human-meaningful label available on a record. */
function recordLabel(record: Record_): string {
  for (const key of ["display_name", "number", "name", "title", "file_name", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return record.id !== undefined ? `#${String(record.id)}` : "(unnamed)";
}

function renderRecordMarkdown(record: Record_, heading: string): string {
  const lines = [heading, ""];
  for (const [key, value] of Object.entries(record)) {
    if (key === "id") continue;
    lines.push(`- **${key}**: ${renderValue(value)}`);
  }
  return lines.join("\n");
}

export interface ListResponseOptions<T extends Record_> {
  /** Raw easybill list envelope. */
  list: EasybillList<T>;
  /** Plural resource label used in headings, e.g. "documents". */
  resource: string;
  /** Compact field set used when the caller passes no `fields`. */
  defaultFields: readonly string[];
  fields?: string[];
  format: ResponseFormat;
  /** Echoed back so the agent can see what it filtered on. */
  filters?: Record<string, unknown>;
}

/**
 * Builds a list tool result: field-selected items, pagination metadata,
 * and truncation if the payload would blow past CHARACTER_LIMIT.
 */
export function buildListResponse<T extends Record_>(options: ListResponseOptions<T>): ToolResult {
  const { list, resource, defaultFields, fields, format, filters } = options;

  const rawItems = Array.isArray(list?.items) ? list.items : [];
  const page = list?.page ?? 1;
  const pages = list?.pages ?? 1;
  const total = list?.total ?? rawItems.length;

  if (rawItems.length === 0) {
    const active = Object.entries(filters ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    const filterText = active.length
      ? ` matching ${active.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`
      : "";
    return textResult(
      `No ${resource} found${filterText}. ` +
        `Try widening the filters, or check the spelling of any name/number filter.`,
    );
  }

  const shaped = rawItems.map((item) => selectFields(item, defaultFields, fields));

  const buildOutput = (items: Record_[], truncation?: string): Record_ => ({
    total,
    count: items.length,
    page,
    pages,
    has_more: page < pages,
    ...(page < pages ? { next_page: page + 1 } : {}),
    items,
    ...(truncation ? { truncated: true, truncation_message: truncation } : {}),
  });

  const render = (output: Record_): string => {
    if (format === "json") return JSON.stringify(output, null, 2);

    const items = output.items as Record_[];
    const lines = [
      `# ${resource} (${items.length} of ${total})`,
      `Page ${page} of ${pages}${output.has_more ? ` — request page ${page + 1} for more` : ""}`,
      "",
    ];
    for (const item of items) {
      lines.push(renderRecordMarkdown(item, `## ${recordLabel(item)} (id ${String(item.id)})`));
      lines.push("");
    }
    if (output.truncation_message) lines.push(`> ${String(output.truncation_message)}`);
    return lines.join("\n");
  };

  let output = buildOutput(shaped);
  let text = render(output);

  // Halve the item count until the payload fits, so the agent still gets usable data.
  if (text.length > CHARACTER_LIMIT) {
    let kept = shaped.length;
    while (text.length > CHARACTER_LIMIT && kept > 1) {
      kept = Math.max(1, Math.floor(kept / 2));
      const message =
        `Response truncated from ${shaped.length} to ${kept} ${resource}. ` +
        `Use a smaller 'limit', add filters, or pass 'fields' to request fewer columns.`;
      output = buildOutput(shaped.slice(0, kept), message);
      text = render(output);
    }
  }

  return { content: [{ type: "text", text }], structuredContent: output };
}

export interface RecordResponseOptions {
  record: Record_ | undefined;
  /** Singular resource label, e.g. "document". */
  resource: string;
  defaultFields: readonly string[];
  /** Single-record lookups return everything unless the caller narrows it. */
  fields?: string[];
  format: ResponseFormat;
  /** Set when the caller asked for a compact view by default. */
  compact?: boolean;
}

/** Builds a single-record tool result. */
export function buildRecordResponse(options: RecordResponseOptions): ToolResult {
  const { record, resource, defaultFields, fields, format, compact = false } = options;

  if (!record || typeof record !== "object") {
    return textResult(`No ${resource} returned by easybill.`);
  }

  // Detail views default to the complete record; compact views to the summary set.
  const shaped =
    fields === undefined && !compact ? record : selectFields(record, defaultFields, fields);

  const text =
    format === "json"
      ? JSON.stringify(shaped, null, 2)
      : renderRecordMarkdown(
          shaped,
          `# ${resource}: ${recordLabel(record)} (id ${String(record.id ?? "?")})`,
        );

  const truncated =
    text.length > CHARACTER_LIMIT
      ? `${text.slice(0, CHARACTER_LIMIT)}\n\n> Response truncated at ${CHARACTER_LIMIT} characters. Pass 'fields' to request only the columns you need.`
      : text;

  return { content: [{ type: "text", text: truncated }], structuredContent: shaped };
}

/** Confirmation result for a mutation, echoing the affected record. */
export function buildMutationResponse(
  action: string,
  resource: string,
  record: Record_ | undefined,
  format: ResponseFormat,
  defaultFields: readonly string[],
): ToolResult {
  if (!record || typeof record !== "object" || Object.keys(record).length === 0) {
    return textResult(`${action} ${resource} succeeded.`);
  }
  const shaped = selectFields(record, defaultFields);
  const summary = `${action} ${resource} ${recordLabel(record)} (id ${String(record.id ?? "?")}).`;
  const text =
    format === "json"
      ? JSON.stringify({ message: summary, [resource]: shaped }, null, 2)
      : `${summary}\n\n${renderRecordMarkdown(shaped, `## ${resource}`)}`;
  return {
    content: [{ type: "text", text }],
    structuredContent: { message: summary, [resource]: shaped },
  };
}
