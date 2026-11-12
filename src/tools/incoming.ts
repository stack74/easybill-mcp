/**
 * Incoming documents (Eingangsbelege): supplier invoices and credit notes that
 * arrive by upload or e-mail, are extracted by easybill in the background, and
 * are then reviewed and completed. API 1.100-1.102.
 *
 * Unlike every other easybill resource these use UUIDs, not numeric IDs, so
 * they are written out here instead of going through the CRUD factory.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DATE_RANGE_HINT, SUMMARY_FIELDS } from "../constants.js";
import { dataSchema, fieldsSchema, listBaseShape, responseFormatSchema } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
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
import { deliverFile, downloadNote, downloadShape, multipartFile, readUpload, uploadShape } from "./files-io.js";
import { type Args, registerRead, registerWrite } from "./registry.js";

/** Validated before it goes into a URL path. */
const uuid = (what: string) =>
  z
    .string()
    .regex(/^[0-9a-fA-F-]{8,64}$/, "must be a UUID")
    .describe(`UUID of the ${what} (incoming documents use UUIDs, not numbers).`);

const MONEY = "Amounts are INTEGERS IN CENTS (11900 = 119.00 EUR).";

const UPDATE_HINT = `${MONEY}

Editable fields:
- document_type: 'INVOICE' or 'CREDIT_NOTE' (required before completing)
- supplier_id (integer): the easybill contact (contactType SUPPLIER) this document is from
- external_number (string): the supplier's own document number
- issue_date, due_date, delivery_date (YYYY-MM-DD)
- currency_code (string), total_net_amount, total_gross_amount (integer, cents)
- accounting_positions (array, REPLACES all positions): each { net_amount (cents, required),
  tax_amount (cents), tax_rate (decimal string, e.g. "19.00"), financial_accounting_account (string),
  id (to modify an existing position) }
- supplier (object): name, email, vat_id, iban, bic, address_line_1..3, address_post_code,
  address_city_name, address_country_id

Read-only (ignored): status, document_number, is_paid, payments, interface.
Allowed while status is DRAFT or DONE.`;

const format = (args: Args): ResponseFormat => (args.response_format as ResponseFormat | undefined) ?? "markdown";
const path = (id: unknown): string => `/incoming-documents/${encodeURIComponent(String(id))}`;

export function registerIncomingDocumentTools(server: McpServer, client: ApiClient): void {
  registerRead(
    server,
    {
      name: "easybill_list_incoming_documents",
      title: "List incoming documents (Eingangsbelege)",
      description:
        "List incoming documents — supplier invoices and credit notes received by upload or e-mail.\n\n" +
        "Status: PREPARING/PROCESSING (easybill is still extracting the data), DRAFT (extracted, to be " +
        "reviewed), DONE (completed, has an internal 'document_number'), ERROR or VIRUS.\n\n" +
        "To find one by supplier name, number or a word, use easybill_search_incoming_documents. " +
        `${MONEY}\n\n` +
        "Returns: { total, count, page, pages, has_more, next_page, items[] }.",
      inputSchema: {
        ...listBaseShape,
        created_at: z.string().optional().describe(`Filter by creation date. ${DATE_RANGE_HINT}`),
        sort: z.enum(["ASC", "DESC"]).optional().describe("Sort by creation date; 'DESC' = newest first."),
      },
    },
    async (args): Promise<ToolResult> => {
      const filters: Record_ = {};
      if (args.created_at) filters.created_at = args.created_at;
      if (args.sort) filters.sort = args.sort;
      const list = await client.request<EasybillList<Record_>>("/incoming-documents", {
        query: {
          limit: args.limit as number,
          page: args.page as number,
          ...(filters as Record<string, string>),
        },
      });
      const fields = args.fields as string[] | undefined;
      return buildListResponse({
        list,
        resource: "incoming documents",
        defaultFields: SUMMARY_FIELDS.incomingDocument,
        ...(fields ? { fields } : {}),
        format: format(args),
        filters,
      });
    },
  );

  registerRead(
    server,
    {
      name: "easybill_search_incoming_documents",
      title: "Search incoming documents (full text)",
      description:
        "Full-text search over incoming documents (supplier invoices/credit notes): supplier name, " +
        "the supplier's document number, amounts or other extracted text. One request.\n\n" +
        "Returns: { total, count, page, pages, has_more, next_page, items[] }.",
      inputSchema: {
        query: z.string().min(2).max(200).describe("Search text, e.g. a supplier name or invoice number."),
        limit: z.number().int().min(1).max(100).default(25).describe("Items per page (default 25)."),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
        fields: fieldsSchema,
        response_format: responseFormatSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      const list = await client.request<EasybillList<Record_>>("/incoming-documents/search", {
        query: { query: args.query as string, limit: args.limit as number, page: args.page as number },
      });
      const fields = args.fields as string[] | undefined;
      return buildListResponse({
        list,
        resource: "incoming documents",
        defaultFields: SUMMARY_FIELDS.incomingDocument,
        ...(fields ? { fields } : {}),
        format: format(args),
        filters: { query: args.query },
      });
    },
  );

  registerRead(
    server,
    {
      name: "easybill_get_incoming_document",
      title: "Get incoming document",
      description:
        "Fetch one incoming document with all fields: supplier, amounts, accounting positions (tax split) " +
        `and recorded payments. ${MONEY}`,
      inputSchema: { id: uuid("incoming document"), fields: fieldsSchema, response_format: responseFormatSchema },
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(path(args.id));
      const fields = args.fields as string[] | undefined;
      return buildRecordResponse({
        record,
        resource: "incoming document",
        defaultFields: SUMMARY_FIELDS.incomingDocument,
        fields: fields ?? ["all"],
        format: format(args),
      });
    },
  );

  registerRead(
    server,
    {
      name: "easybill_list_incoming_document_files",
      title: "List files of an incoming document",
      description:
        "List the files (the original PDF/image and any others) attached to an incoming document. " +
        "Use a file's 'id' with easybill_download_incoming_document_file.",
      inputSchema: {
        id: uuid("incoming document"),
        limit: z.number().int().min(1).max(1000).default(25).describe("Items per page."),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
        response_format: responseFormatSchema,
      },
    },
    async (args): Promise<ToolResult> => {
      const list = await client.request<EasybillList<Record_>>(`${path(args.id)}/files`, {
        query: { limit: args.limit as number, page: args.page as number },
      });
      return buildListResponse({
        list,
        resource: "files",
        defaultFields: ["id", "name", "extension", "size", "created_at"],
        format: format(args),
      });
    },
  );

  registerRead(
    server,
    {
      name: "easybill_download_incoming_document_file",
      title: "Download a file of an incoming document",
      description:
        "Download one file of an incoming document (find its id with easybill_list_incoming_document_files).\n\n" +
        downloadNote(server),
      inputSchema: {
        id: uuid("incoming document"),
        file_id: uuid("file"),
        ...downloadShape(server, "/Users/me/Desktop/supplier-invoice.pdf"),
      },
    },
    async (args): Promise<ToolResult> => {
      const binary = await client.requestBinary(
        `${path(args.id)}/files/${encodeURIComponent(String(args.file_id))}/download`,
        { accept: "*/*" },
      );
      return deliverFile(server, args, binary, {
        label: `File ${String(args.file_id)} of incoming document ${String(args.id)}`,
        fileName: `incoming-${String(args.file_id)}`,
        meta: { incoming_document_id: args.id, file_id: args.file_id },
      });
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_upload_incoming_document",
      title: "Upload an incoming document",
      description:
        "Upload a supplier invoice or credit note (PDF or image) as a new incoming document.\n\n" +
        "easybill extracts supplier, amounts and dates in the background: the returned document has status " +
        "PREPARING or PROCESSING. Fetch it again with easybill_get_incoming_document after a short while " +
        "to see the extracted data (status DRAFT), review it, correct it with " +
        "easybill_update_incoming_document and finish with easybill_complete_incoming_document.\n\n" +
        "Fails with 426 when the plan's archive document limit is reached.",
      inputSchema: { ...uploadShape(server), response_format: responseFormatSchema },
    },
    async (args): Promise<ToolResult> => {
      const file = await readUpload(server, args);
      if (typeof file === "string") return textResult(file, true);
      const { body, contentType } = multipartFile("file", file);
      const record = await client.request<Record_>("/incoming-documents", {
        method: "POST",
        rawBody: body,
        headers: { "Content-Type": contentType },
      });
      return buildMutationResponse(
        `Uploaded ${file.fileName} (processing in the background) —`,
        "incoming document",
        record,
        format(args),
        SUMMARY_FIELDS.incomingDocument,
      );
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_update_incoming_document",
      title: "Update an incoming document",
      description:
        "Correct or complete the data of an incoming document. Only the fields in 'data' change.\n\n" +
        `${UPDATE_HINT}\n\nReturns the updated incoming document.`,
      inputSchema: {
        id: uuid("incoming document"),
        data: dataSchema(`Fields to change. ${UPDATE_HINT}`),
        response_format: responseFormatSchema,
      },
      idempotent: true,
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(path(args.id), { method: "PUT", body: args.data });
      return buildMutationResponse("Updated", "incoming document", record, format(args), SUMMARY_FIELDS.incomingDocument);
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_complete_incoming_document",
      title: "Complete an incoming document",
      description:
        "Mark an incoming document as DONE. easybill assigns the next internal 'document_number'.\n\n" +
        "Requires a 'document_type' and balanced amounts: net amount plus the tax amounts of all accounting " +
        "positions must equal the gross amount. Review the document with the user before completing it.",
      inputSchema: { id: uuid("incoming document"), response_format: responseFormatSchema },
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(`${path(args.id)}/done`, { method: "PUT" });
      return buildMutationResponse("Completed", "incoming document", record, format(args), SUMMARY_FIELDS.incomingDocument);
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_delete_incoming_document",
      title: "Delete an incoming document",
      description:
        "Permanently delete an incoming document in any status, including DONE. This cannot be undone. " +
        "Fails with 409 while easybill is still processing it. Confirm with the user first.",
      inputSchema: { id: uuid("incoming document") },
      destructive: true,
      idempotent: true,
    },
    async (args): Promise<ToolResult> => {
      await client.request<void>(path(args.id), { method: "DELETE" });
      return textResult(`Deleted incoming document ${String(args.id)}.`);
    },
  );
}
