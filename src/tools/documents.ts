/**
 * Documents: invoices, offers, credit notes, deliveries, orders and friends.
 * The core of the easybill API — CRUD plus the lifecycle actions
 * (complete, cancel, convert, send, download).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CONVERTIBLE_TYPES,
  DATE_RANGE_HINT,
  DOCUMENT_TYPES,
  SUMMARY_FIELDS,
} from "../constants.js";
import { dateFilter, idSchema, multiFilter } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
import {
  type EasybillList,
  type Record_,
  type ResponseFormat,
  type ToolResult,
  buildListResponse,
  buildMutationResponse,
} from "../services/format.js";
import { type Args, registerCrudTools } from "./crud.js";
import { registerRead, registerWrite } from "./registry.js";

/**
 * The money-in-cents rule is the single most common source of wrong invoices,
 * so it is repeated in every tool description that touches an amount.
 */
const MONEY_RULE =
  "IMPORTANT: all monetary values are INTEGERS IN CENTS — 150 means 1.50 EUR, " +
  "so 19.99 EUR must be sent as 1999. Never send decimal euros.";

/**
 * Prepended to the create-document description. An agent handed an inbound inquiry
 * will otherwise reach for this tool (or worse, list documents) before it has
 * established who the customer is.
 */
const CREATE_WORKFLOW = `WORKFLOW — do this in order. A document needs a customer_id, so resolve the customer FIRST:

  1. easybill_find_customer  — does this customer already exist? (fuzzy name/email search)
  2. easybill_create_customer — only if step 1 found nothing
  3. this tool               — creates a DRAFT document
  4. show the draft to the user for review
  5. easybill_complete_document — assigns the official number and locks it
  6. easybill_send_document  — only when explicitly asked

Do NOT call easybill_list_documents to orient yourself first — it cannot tell you whether
the customer exists, and it wastes requests against a low rate limit.

If prices were not given to you, do not invent them: look up articles with
easybill_list_positions and reference them via 'position_id', or ask the user.`;

const DOCUMENT_BODY_HINT = `${MONEY_RULE}

Key fields:
- type (string): one of ${DOCUMENT_TYPES.join(", ")}. Defaults to INVOICE. Can only be set on create.
- customer_id (integer): the easybill customer this document belongs to. Look it up with easybill_list_customers.
- document_date (string): YYYY-MM-DD, timezone Europe/Berlin.
- title (string), text (string), text_prefix (string): heading and body copy.
- items (array): the line items. Each item accepts:
    description (string), quantity (number), unit (string),
    single_price_net or single_price_gross (integer, CENTS),
    vat_percent (number, default 19), discount (number), discount_type ('PERCENT'|'AMOUNT'),
    position_id (integer — reference an existing article and inherit its values),
    number (string), position (integer, ordering).
- calc_vat_from (0|1): 0 = prices are net (default), 1 = prices are gross.
- currency (string): ISO code, default EUR.
- discount (string) + discount_type ('PERCENT'|'AMOUNT'): document-level discount.
- grace_period (integer): days until due. Set this instead of due_date, which is derived.
- pdf_template (string): null/'DE' for German, 'EN' for English, or a numeric template ID.
- vat_option (string): NULL, nStb, nStbUstID, nStbNoneUstID, nStbIm, revc, IG, AL, sStfr, smallBusiness.
- project_id (integer), ref_id (string), external_id (string), order_number (string).
- status (string): only for DELIVERY, ORDER, CHARGE or OFFER — ACCEPT, DONE, DROPSHIPPING or CANCEL.

Read-only fields you cannot set directly: id, number, amount, amount_net, due_date,
is_draft (use easybill_complete_document), paid_amount, paid_at.

New documents are created as drafts. Call easybill_complete_document to finalise one
and have easybill assign its official document number.`;

export function registerDocumentTools(server: McpServer, client: ApiClient): void {
  registerCrudTools(server, client, {
    singular: "document",
    plural: "documents",
    nameSingular: "document",
    namePlural: "documents",
    path: "/documents",
    defaultFields: SUMMARY_FIELDS.document,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes:
      "Covers every document type: invoices, offers, credit notes, reminders, deliveries, orders.\n\n" +
      "NOT the right tool for: finding out whether a customer exists (use easybill_find_customer), " +
      "or orienting yourself before creating a document (see easybill_create_document). " +
      "Only call this when you actually need to read existing documents, and always with a filter.\n\n" +
      "Common recipes:\n" +
      "- Unpaid invoices: type='INVOICE', paid_at='null'\n" +
      "- Revenue in a period: type='INVOICE', document_date='2025-01-01,2025-12-31'\n" +
      "- A customer's history: customer_id=<id>\n" +
      "- Exclude drafts: is_draft='0'   - exclude cancelled: cancel_id='null'",
    bodyHint: DOCUMENT_BODY_HINT,
    createNotes: CREATE_WORKFLOW,
    deleteNotes:
      "Completed (non-draft) invoices usually cannot be deleted for legal reasons — " +
      "cancel them with easybill_cancel_document instead, which creates a proper STORNO document.",
    filters: {
      type: z
        .string()
        .optional()
        .describe(
          `Filter by document type. One of ${DOCUMENT_TYPES.join(", ")}, or several comma-separated (e.g. 'INVOICE,CREDIT').`,
        ),
      customer_id: multiFilter("Filter by customer ID."),
      project_id: multiFilter("Filter by project ID."),
      number: multiFilter("Filter by document number (the official invoice number)."),
      title: z.string().optional().describe("Filter by document title."),
      status: z
        .string()
        .optional()
        .describe("Filter by status (ACCEPT, DONE, DROPSHIPPING, CANCEL). Not all types have one."),
      is_draft: z
        .enum(["0", "1"])
        .optional()
        .describe("'0' = only completed documents, '1' = only drafts."),
      is_archive: z.enum(["0", "1"]).optional().describe("'0' = not archived, '1' = archived only."),
      document_date: dateFilter("document date"),
      paid_at: z
        .string()
        .optional()
        .describe(
          `Filter by payment date. ${DATE_RANGE_HINT}. Use the literal string 'null' to find all UNPAID documents.`,
        ),
      edited_at: dateFilter("last edit date"),
      cancel_id: multiFilter(
        "Filter by the ID of the cancelling document. Use the literal string 'null' for all documents that are NOT cancelled.",
      ),
      ref_id: z.string().optional().describe("Filter by reference ID."),
      vat_country: z.string().optional().describe("Filter by VAT country (ISO 2-letter code)."),
      shipping_country: z.string().optional().describe("Filter by shipping country (ISO code)."),
      fulfillment_country: z
        .string()
        .optional()
        .describe("Filter by fulfillment country (ISO code)."),
    },
  });

  const format = (args: Args): ResponseFormat =>
    (args.response_format as ResponseFormat | undefined) ?? "markdown";

  registerWrite(
    server,
    {
      name: "easybill_complete_document",
      title: "Complete document",
      description:
        "Finalise a draft document. easybill assigns the official document number and the " +
        "document stops being editable — this is what turns a draft into a real invoice.\n\n" +
        "Call this after easybill_create_document, once the line items are correct.\n" +
        "Returns the completed document including its assigned 'number'.",
      inputSchema: {
        id: idSchema("document to complete"),
        reason_for_change: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Optional note stored on the document version as the reason for the change."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(`/documents/${String(args.id)}/done`, {
        method: "PUT",
        query: { reason_for_change: args.reason_for_change as string | undefined },
      });
      return buildMutationResponse(
        "Completed",
        "document",
        record,
        format(args),
        SUMMARY_FIELDS.document,
      );
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_cancel_document",
      title: "Cancel document",
      description:
        "Cancel a document by creating a matching cancellation (STORNO) document. This is the " +
        "legally correct way to void a completed invoice — use it instead of easybill_delete_document.\n\n" +
        "Returns the newly created STORNO document. The original document's 'cancel_id' then " +
        "points at it.",
      inputSchema: {
        id: idSchema("document to cancel"),
        use_text_from_template: z
          .boolean()
          .default(false)
          .describe("Use the standard cancellation texts from the PDF template."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      destructive: true,
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(`/documents/${String(args.id)}/cancel`, {
        method: "POST",
        query: { use_text_from_template: args.use_text_from_template as boolean },
      });
      return buildMutationResponse(
        "Created cancellation for",
        "document",
        record,
        format(args),
        SUMMARY_FIELDS.document,
      );
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_convert_document",
      title: "Convert document to another type",
      description:
        "Convert an existing document into a new document of a different type, copying over the " +
        "customer and line items. The source document is left untouched.\n\n" +
        "Typical flows: OFFER -> INVOICE (accepted quote), INVOICE -> DUNNING or REMINDER " +
        "(chasing payment), INVOICE -> CREDIT (credit note), ORDER -> DELIVERY.\n\n" +
        "Returns the newly created document.",
      inputSchema: {
        id: idSchema("source document"),
        type: z
          .enum(CONVERTIBLE_TYPES)
          .describe(`Target document type. One of: ${CONVERTIBLE_TYPES.join(", ")}.`),
        pdf_template: z
          .string()
          .optional()
          .describe("PDF template ID for the new document. Defaults to 'DE'."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
    },
    async (args): Promise<ToolResult> => {
      const record = await client.request<Record_>(
        `/documents/${String(args.id)}/${String(args.type)}`,
        {
          method: "POST",
          query: { pdf_template: args.pdf_template as string | undefined },
        },
      );
      return buildMutationResponse(
        `Converted to ${String(args.type)} —`,
        "document",
        record,
        format(args),
        SUMMARY_FIELDS.document,
      );
    },
  );

  registerWrite(
    server,
    {
      name: "easybill_send_document",
      title: "Send document",
      description:
        "Send a document to the customer by email, fax or post. This dispatches real mail to a " +
        "real recipient — confirm the recipient and document before calling.\n\n" +
        "For 'email', 'to' may hold several addresses separated by commas. Leave 'to' empty to use " +
        "the address stored on the customer.\n\n" +
        "Returns the post box entry created for the send.",
      inputSchema: {
        id: idSchema("document to send"),
        type: z
          .enum(["email", "fax", "post"])
          .describe("Delivery channel: 'email', 'fax' or 'post'."),
        to: z
          .string()
          .optional()
          .describe(
            "Recipient(s). For email, several addresses may be separated by comma, semicolon or newline. Omit to use the customer's stored address.",
          ),
        cc: z.string().optional().describe("CC recipient(s) for email sends."),
        subject: z.string().optional().describe("Subject line."),
        message: z.string().optional().describe("Message body."),
        send_with_attachment: z
          .boolean()
          .default(true)
          .describe("Attach the document itself to the message."),
        document_file_type: z
          .enum([
            "default",
            "zugferd1",
            "zugferd2_2",
            "zugferd2_4_en16931",
            "zugferd2_4_extended",
            "zugferd2_5_en16931",
            "zugferd2_5_extended",
            "xrechnung",
            "xrechnung_xml",
            "xrechnung2_2_xml",
            "xrechnung3_0_xml",
          ])
          .optional()
          .describe(
            "Attachment format for e-invoicing. Omit to use the format configured on the customer.",
          ),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      destructive: true,
    },
    async (args): Promise<ToolResult> => {
      const body: Record_ = { send_with_attachment: args.send_with_attachment };
      for (const key of ["to", "cc", "subject", "message", "document_file_type"] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const record = await client.request<Record_>(
        `/documents/${String(args.id)}/send/${String(args.type)}`,
        { method: "POST", body },
      );
      return buildMutationResponse(
        `Sent via ${String(args.type)} —`,
        "document",
        record,
        format(args),
        ["id", "document_id", "type", "status", "status_msg", "to", "cc", "subject", "created_at"],
      );
    },
  );

  registerRead(
    server,
    {
      name: "easybill_download_document",
      title: "Download document file",
      description:
        "Download a document as a PDF or e-invoicing file and save it to a local path.\n\n" +
        "Supported formats: 'pdf' (plain), 'zugferd1', 'zugferd2_2' (PDF with embedded XML), " +
        "'xrechnung2_3', 'xrechnung3_0' (XML), and 'jpg' (first page as an image).\n\n" +
        "Returns the saved file path and its size in bytes. The file content itself is NOT loaded " +
        "into the conversation, so this is safe for large PDFs.",
      inputSchema: {
        id: idSchema("document to download"),
        output_path: z
          .string()
          .min(1)
          .describe(
            "Absolute path to write the file to, e.g. '/Users/me/Desktop/invoice-123.pdf'. Parent directory must exist.",
          ),
        format: z
          .enum(["pdf", "jpg", "zugferd1", "zugferd2_2", "xrechnung2_3", "xrechnung3_0"])
          .default("pdf")
          .describe("File format to request."),
      },
    },
    async (args): Promise<ToolResult> => {
      const requested = args.format as string;
      const outputPath = args.output_path as string;

      // Plain pdf/jpg have dedicated endpoints; e-invoice formats are negotiated
      // through the Accept header on /download.
      const acceptByFormat: Record<string, string> = {
        zugferd1: "application/pdf;format=zugferd;version=1.0.0",
        zugferd2_2: "application/pdf;format=zugferd;version=2.2.0",
        xrechnung2_3: "application/xml;format=xrechnung;version=2.3.0",
        xrechnung3_0: "application/xml;format=xrechnung;version=3.0.1",
      };

      const binary =
        requested === "pdf" || requested === "jpg"
          ? await client.requestBinary(`/documents/${String(args.id)}/${requested}`, {
              accept: requested === "pdf" ? "application/pdf" : "image/jpeg",
            })
          : await client.requestBinary(`/documents/${String(args.id)}/download`, {
              accept: acceptByFormat[requested] ?? "application/pdf",
            });

      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputPath, binary.data);

      const output = {
        saved_to: outputPath,
        bytes: binary.data.byteLength,
        content_type: binary.contentType,
        document_id: args.id,
        format: requested,
      };
      return {
        content: [
          {
            type: "text",
            text:
              `Saved document ${String(args.id)} as ${requested} to ${outputPath} ` +
              `(${binary.data.byteLength.toLocaleString("en-US")} bytes, ${binary.contentType}).`,
          },
        ],
        structuredContent: output,
      };
    },
  );

  registerRead(
    server,
    {
      name: "easybill_list_document_versions",
      title: "List document versions",
      description:
        "List the change history of a document. easybill snapshots a version whenever a " +
        "completed document is modified, which is what you need for audit questions like " +
        "'was this invoice altered after it was issued?'.\n\n" +
        "Returns: { total, count, page, pages, items[] } with each version's id, created_at and reason.",
      inputSchema: {
        id: idSchema("document"),
        limit: z.number().int().min(1).max(1000).default(25).describe("Items per page."),
        page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
    },
    async (args): Promise<ToolResult> => {
      const list = await client.request<EasybillList<Record_>>(
        `/documents/${String(args.id)}/versions`,
        { query: { limit: args.limit as number, page: args.page as number } },
      );
      return buildListResponse({
        list,
        resource: "document versions",
        defaultFields: ["id", "document_id", "created_at", "reason", "items"],
        format: format(args),
      });
    },
  );
}
