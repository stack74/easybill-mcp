/**
 * Tool registration helpers.
 *
 * `registerRead` always registers. `registerWrite` only registers when writes
 * are enabled for the server, so a default install cannot mutate live
 * accounting data and read-only sessions keep a lean tool list.
 *
 * In hosted (multi-account) mode every tool additionally takes an `account`
 * argument; the wrapper strips it, checks it, and runs the handler with that
 * account's client selected (see ServerContext.accounts.run).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
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
  /** Hosted mode: the tool does not talk to a specific account, so it gets no `account` argument. */
  accountless?: boolean;
}

/** An easybill account a hosted session can address. */
export interface AccountChoice {
  id: string;
  name: string;
  /** Whether write tools may run against this account. */
  writes: boolean;
}

export interface RegistrationStats {
  read: number;
  write: number;
  skipped: number;
}

/** Per-server settings that decide how tools are registered and dispatched. */
export interface ServerContext {
  writesEnabled: boolean;
  /** Hosted mode only. Absent in stdio mode, where there is exactly one account. */
  accounts?: {
    list: AccountChoice[];
    /** Runs `fn` with the given account's client selected. */
    run<T>(accountId: string, fn: () => Promise<T>): Promise<T>;
  };
  stats: RegistrationStats;
}

const contexts = new WeakMap<McpServer, ServerContext>();

/** Must be called before any tool is registered on `server`. */
export function setServerContext(server: McpServer, context: ServerContext): void {
  contexts.set(server, context);
}

/**
 * Hosted (multi-user) mode. Tools must then never touch the server's file
 * system on a caller's behalf: no writing to or reading from caller-chosen paths.
 */
export function isHosted(server: McpServer): boolean {
  return serverContext(server).accounts !== undefined;
}

export function serverContext(server: McpServer): ServerContext {
  let context = contexts.get(server);
  if (!context) {
    context = { writesEnabled: WRITES_ENABLED, stats: { read: 0, write: 0, skipped: 0 } };
    contexts.set(server, context);
  }
  return context;
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

function accountSchema(list: AccountChoice[]) {
  const ids = list.map((a) => a.id) as [string, ...string[]];
  const names = list.map((a) => `'${a.id}' = ${a.name}${a.writes ? "" : " (read-only)"}`).join(", ");
  const base = z.enum(ids);
  return list.length === 1
    ? base.optional().describe(`easybill account. Only one is connected (${names}), so this can be omitted.`)
    : base.describe(
        `Which easybill account to act on: ${names}. Required — IDs, numbers and customers differ between accounts.`,
      );
}

/** Adds the `account` argument in hosted mode. */
function shapeFor(context: ServerContext, spec: ToolSpec<ZodRawShape>): ZodRawShape {
  const accounts = context.accounts;
  if (!accounts || spec.accountless || accounts.list.length === 0) return spec.inputSchema;
  return { ...spec.inputSchema, account: accountSchema(accounts.list) };
}

/** Hosted mode: resolve the `account` argument and run the handler against it. */
function routed(context: ServerContext, spec: ToolSpec<ZodRawShape>, handler: Handler, write: boolean): Handler {
  const accounts = context.accounts;
  if (!accounts || spec.accountless) return handler;
  return async (args: Args): Promise<ToolResult> => {
    const { account, ...rest } = args;
    const list = accounts.list;
    if (list.length === 0) {
      return textResult(
        "Error: no easybill account is connected to this session. Call easybill_list_accounts for the link to connect one.",
        true,
      );
    }
    const id = typeof account === "string" ? account : list.length === 1 ? list[0]!.id : undefined;
    const choice = list.find((a) => a.id === id);
    if (!choice) {
      return textResult(
        `Error: pass 'account' — one of ${list.map((a) => `'${a.id}' (${a.name})`).join(", ")}.`,
        true,
      );
    }
    if (write && !choice.writes) {
      return textResult(
        `Error: the account '${choice.id}' (${choice.name}) is read-only on this server. ` +
          `Create, update and delete are not allowed there.`,
        true,
      );
    }
    return accounts.run(choice.id, () => handler(rest));
  };
}

export function registerRead<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: Handler,
): void {
  const context = serverContext(server);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: shapeFor(context, spec),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(routed(context, spec, handler, false)) as never,
  );
  context.stats.read++;
}

export function registerWrite<Shape extends ZodRawShape>(
  server: McpServer,
  spec: ToolSpec<Shape>,
  handler: Handler,
): void {
  const context = serverContext(server);
  if (!context.writesEnabled) {
    context.stats.skipped++;
    return;
  }
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: shapeFor(context, spec),
      annotations: {
        readOnlyHint: false,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: spec.idempotent ?? false,
        openWorldHint: true,
      },
    },
    guard(routed(context, spec, handler, true)) as never,
  );
  context.stats.write++;
}
