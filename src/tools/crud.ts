/**
 * Generic CRUD tool factory.
 *
 * Most easybill resources expose the same five operations over the same
 * pagination envelope, so they are generated from a declarative config here
 * instead of being hand-written five times per resource. Resource-specific
 * behaviour (document actions, downloads, sending) lives in its own module.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { z } from "zod";
import type { ApiClient, QueryParams } from "../services/client.js";
import {
  type EasybillList,
  type Record_,
  type ResponseFormat,
  type ToolResult,
  buildListResponse,
  buildMutationResponse,
  buildRecordResponse,
  textResult,
} from "../services/format.js";
import { dataSchema, idSchema, listBaseShape, recordBaseShape } from "../schemas/common.js";
import { type Args, registerRead, registerWrite } from "./registry.js";

export type { Args };

export type CrudOperation = "list" | "get" | "create" | "update" | "delete";

export interface ParentConfig {
  /** Parameter name, e.g. "customer_id". */
  param: string;
  /** Path segment prefix builder, e.g. (id) => `/customers/${id}`. */
  path: (parentId: number) => string;
  description: string;
}

export interface CrudConfig {
  /** Singular resource label, e.g. "document". */
  singular: string;
  /** Plural resource label used in tool names and headings, e.g. "documents". */
  plural: string;
  /** Tool name stem, e.g. "document" -> easybill_list_documents / easybill_get_document. */
  namePlural: string;
  nameSingular: string;
  /** API path relative to the base URL, e.g. "/documents". */
  path: string;
  defaultFields: readonly string[];
  /** Which operations to generate. */
  operations: CrudOperation[];
  /** Extra list filter parameters beyond limit/page/fields/response_format. */
  filters?: ZodRawShape;
  /** Prose appended to the list tool description. */
  listNotes?: string;
  /** Prose describing the create/update body — document the important fields here. */
  bodyHint: string;
  /**
   * Prose placed at the very TOP of the create tool description, before the field
   * reference. Use it for prerequisite ordering ("resolve the customer first").
   */
  createNotes?: string;
  /** Extra prose for the delete tool, e.g. legal caveats. */
  deleteNotes?: string;
  /** Nested resource parent, e.g. contacts live under a customer. */
  parent?: ParentConfig;
}

/** Reads the standard shared params off an args bag. */
function readCommon(args: Args): { fields?: string[]; format: ResponseFormat } {
  const fields = args.fields as string[] | undefined;
  const format = (args.response_format as ResponseFormat | undefined) ?? "markdown";
  return { ...(fields ? { fields } : {}), format };
}

/** Collects declared filter values out of the args bag into a query object. */
function readFilters(args: Args, filters: ZodRawShape | undefined): QueryParams {
  const query: QueryParams = {};
  if (!filters) return query;
  for (const key of Object.keys(filters)) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    query[key] = value as QueryParams[string];
  }
  return query;
}

/** Builds the collection path, honouring a nested parent if configured. */
function collectionPath(config: CrudConfig, args: Args): string {
  if (!config.parent) return config.path;
  const parentId = args[config.parent.param] as number;
  return `${config.parent.path(parentId)}${config.path}`;
}

const FIELDS_NOTE =
  "Returns a compact field set by default; pass 'fields' for specific columns or ['all'] for everything.";

export function registerCrudTools(
  server: McpServer,
  client: ApiClient,
  config: CrudConfig,
): void {
  const {
    singular,
    plural,
    namePlural,
    nameSingular,
    defaultFields,
    operations,
    filters,
    parent,
  } = config;

  const parentShape: ZodRawShape = parent
    ? { [parent.param]: z.number().int().positive().describe(parent.description) }
    : {};

  if (operations.includes("list")) {
    registerRead(
      server,
      {
        name: `easybill_list_${namePlural}`,
        title: `List ${plural}`,
        description:
          `List ${plural} from easybill with optional filters and pagination.\n\n` +
          `${config.listNotes ? `${config.listNotes}\n\n` : ""}` +
          `${FIELDS_NOTE}\n\n` +
          `Returns: { total, count, page, pages, has_more, next_page, items[] }.\n` +
          `Use 'next_page' to continue paging. Monetary values are integers in cents (150 = 1.50 EUR).`,
        inputSchema: { ...parentShape, ...listBaseShape, ...(filters ?? {}) },
      },
      async (args): Promise<ToolResult> => {
        const { fields, format } = readCommon(args);
        const filterQuery = readFilters(args, filters);
        const list = await client.request<EasybillList<Record_>>(collectionPath(config, args), {
          query: { limit: args.limit as number, page: args.page as number, ...filterQuery },
        });
        return buildListResponse({
          list,
          resource: plural,
          defaultFields,
          ...(fields ? { fields } : {}),
          format,
          filters: filterQuery,
        });
      },
    );
  }

  if (operations.includes("get")) {
    registerRead(
      server,
      {
        name: `easybill_get_${nameSingular}`,
        title: `Get ${singular}`,
        description:
          `Fetch one ${singular} by its numeric easybill ID, returning all fields by default.\n\n` +
          `Use easybill_list_${namePlural} first if you only know a name or number.\n` +
          `Pass 'fields' to narrow the response. Monetary values are integers in cents (150 = 1.50 EUR).`,
        inputSchema: { ...parentShape, id: idSchema(singular), ...recordBaseShape },
      },
      async (args): Promise<ToolResult> => {
        const { fields, format } = readCommon(args);
        const record = await client.request<Record_>(
          `${collectionPath(config, args)}/${String(args.id)}`,
        );
        return buildRecordResponse({
          record,
          resource: singular,
          defaultFields,
          ...(fields ? { fields } : {}),
          format,
        });
      },
    );
  }

  if (operations.includes("create")) {
    registerWrite(
      server,
      {
        name: `easybill_create_${nameSingular}`,
        title: `Create ${singular}`,
        description:
          `Create a new ${singular} in easybill.\n\n` +
          `${config.createNotes ? `${config.createNotes}\n\n` : ""}` +
          `${config.bodyHint}\n\n` +
          `Returns the created ${singular} including its new 'id'.`,
        inputSchema: {
          ...parentShape,
          data: dataSchema(`The ${singular} to create. ${config.bodyHint}`),
          response_format: recordBaseShape.response_format,
        },
      },
      async (args): Promise<ToolResult> => {
        const { format } = readCommon(args);
        const record = await client.request<Record_>(collectionPath(config, args), {
          method: "POST",
          body: args.data,
        });
        return buildMutationResponse("Created", singular, record, format, defaultFields);
      },
    );
  }

  if (operations.includes("update")) {
    registerWrite(
      server,
      {
        name: `easybill_update_${nameSingular}`,
        title: `Update ${singular}`,
        description:
          `Update an existing ${singular}. Only the fields present in 'data' are changed.\n\n` +
          `${config.bodyHint}\n\n` +
          `Fetch the ${singular} first with easybill_get_${nameSingular} to see current values.\n` +
          `Returns the updated ${singular}.`,
        inputSchema: {
          ...parentShape,
          id: idSchema(singular),
          data: dataSchema(`Fields to change on this ${singular}. ${config.bodyHint}`),
          response_format: recordBaseShape.response_format,
        },
        idempotent: true,
      },
      async (args): Promise<ToolResult> => {
        const { format } = readCommon(args);
        const record = await client.request<Record_>(
          `${collectionPath(config, args)}/${String(args.id)}`,
          { method: "PUT", body: args.data },
        );
        return buildMutationResponse("Updated", singular, record, format, defaultFields);
      },
    );
  }

  if (operations.includes("delete")) {
    registerWrite(
      server,
      {
        name: `easybill_delete_${nameSingular}`,
        title: `Delete ${singular}`,
        description:
          `Permanently delete a ${singular} from easybill. This cannot be undone.\n\n` +
          `${config.deleteNotes ? `${config.deleteNotes}\n\n` : ""}` +
          `Confirm the target with easybill_get_${nameSingular} before calling this.`,
        inputSchema: { ...parentShape, id: idSchema(singular) },
        destructive: true,
        idempotent: true,
      },
      async (args): Promise<ToolResult> => {
          await client.request<void>(`${collectionPath(config, args)}/${String(args.id)}`, {
          method: "DELETE",
        });
        return textResult(`Deleted ${singular} with id ${String(args.id)}.`);
      },
    );
  }
}
