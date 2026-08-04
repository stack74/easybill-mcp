/** Zod building blocks reused across every tool. */

import { z } from "zod";
import { DATE_RANGE_HINT } from "../constants.js";
import { RESPONSE_FORMATS } from "../services/format.js";

export const responseFormatSchema = z
  .enum(RESPONSE_FORMATS)
  .default("markdown")
  .describe("Output format: 'markdown' for readable prose, 'json' for machine-readable data");

export const fieldsSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Limit returned columns to these field names (e.g. ['number','amount','paid_at']). " +
      "Pass ['all'] for every field. Omit for a compact default set. Fewer fields = less context used.",
  );

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(25)
  .describe("Items per page, 1-1000 (default 25). Keep this small unless you need bulk data.");

export const pageSchema = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe("Page number, starting at 1. Use 'next_page' from a previous response to continue.");

/** Standard read-list parameters every list tool accepts. */
export const listBaseShape = {
  limit: limitSchema,
  page: pageSchema,
  fields: fieldsSchema,
  response_format: responseFormatSchema,
};

/** Standard single-record parameters. */
export const recordBaseShape = {
  fields: fieldsSchema,
  response_format: responseFormatSchema,
};

export const idSchema = (resource: string) =>
  z.number().int().positive().describe(`The numeric easybill ID of the ${resource}`);

/**
 * A filter that easybill accepts as a single value or comma-separated list.
 * Accepts a scalar or array; the client joins arrays with commas.
 */
export const multiFilter = (description: string) =>
  z
    .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
    .optional()
    .describe(`${description} Accepts one value or a list of values.`);

export const dateFilter = (field: string) =>
  z.string().optional().describe(`Filter by ${field}. ${DATE_RANGE_HINT}`);

/**
 * Free-form object for create/update bodies.
 *
 * easybill's Document and Customer models carry 69 and 79 fields; enumerating
 * them all in a Zod schema would bloat every tool description past usefulness.
 * Instead the important fields are documented in the tool description and the
 * body is passed through, letting easybill's own validation report problems
 * (surfaced verbatim via formatApiError).
 */
export const dataSchema = (hint: string) =>
  z.record(z.string(), z.unknown()).describe(hint);
