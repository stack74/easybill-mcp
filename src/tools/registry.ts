/**
 * Tool registration helpers.
 *
 * `registerRead` always registers. `registerWrite` only registers when
 * EASYBILL_ENABLE_WRITES is set, so a default install cannot mutate live
 * accounting data and read-only sessions keep a lean tool list.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { WRITES_ENABLED } from "../constants.js";
import { formatApiError } from "../services/client.js";
import { type ToolResult, textResult } from "../services/format.js";

export interface ToolSpec<Shape extends ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** True for tools that delete data or are otherwise hard to undo. */
  destructive?: boolean;
  /** True when repeating the call has no additional effect. */
  idempotent?: boolean;
}

/**
 * Validated tool arguments.
 *
 * Deliberately loose: the CRUD factory assembles input shapes at runtime from
 * declarative config, so there is no static shape to infer per tool. The Zod
 * schema passed as `inputSchema` is the real validation boundary — the SDK
 * rejects malformed calls before a handler ever runs, so handlers can read the
 * keys their own schema declares.
 */
export type Args = Record<string, unknown>;

export type Handler = (args: Args) => Promise<ToolResult>;

/** Counts of what actually got registered, for the startup log. */
export const registrationStats = { read: 0, write: 0, skipped: 0 };

/** Wraps a handler so no thrown error ever escapes as a protocol-level failure. */
function guard(handler: Handler): Handler {
  return async (args: Args): Promise<ToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return textResult(formatApiError(error), true);
    }
  };
}

export function registerRead<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: Handler,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(handler) as never,
  );
  registrationStats.read++;
}

export function registerWrite<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: Handler,
): void {
  if (!WRITES_ENABLED) {
    registrationStats.skipped++;
    return;
  }
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: spec.idempotent ?? false,
        openWorldHint: true,
      },
    },
    guard(handler) as never,
  );
  registrationStats.write++;
}
