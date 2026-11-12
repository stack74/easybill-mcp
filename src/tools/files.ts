/** Attachments and the text / PDF template catalogues. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUMMARY_FIELDS } from "../constants.js";
import { idSchema } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
import {
  type EasybillList,
  type Record_,
  type ResponseFormat,
  type ToolResult,
  buildListResponse,
} from "../services/format.js";
import { registerCrudTools } from "./crud.js";
import { deliverFile, downloadNote, downloadShape } from "./files-io.js";
import { registerRead } from "./registry.js";

export function registerFileTools(server: McpServer, client: ApiClient): void {
  registerCrudTools(server, client, {
    singular: "attachment",
    plural: "attachments",
    nameSingular: "attachment",
    namePlural: "attachments",
    path: "/attachments",
    defaultFields: SUMMARY_FIELDS.attachment,
    operations: ["list", "get", "delete"],
    listNotes:
      "Files stored in easybill and linked to a document, customer or project. " +
      "This endpoint has no filters — page through the list and match on 'document_id', " +
      "'customer_id' or 'file_name'.\n" +
      "Use easybill_download_attachment to fetch the actual file content.",
    bodyHint: "Attachments are uploaded as multipart form data, which this server does not expose.",
    deleteNotes: "The file is removed from easybill and unlinked from any document.",
  });

  registerRead(
    server,
    {
      name: "easybill_download_attachment",
      title: "Download attachment",
      description:
        "Download an attachment's file content.\n\n" +
        `${downloadNote(server)}\n` +
        "Find attachment IDs with easybill_list_attachments.",
      inputSchema: {
        id: idSchema("attachment to download"),
        ...downloadShape(server, "/Users/me/Desktop/receipt.pdf"),
      },
    },
    async (args): Promise<ToolResult> => {
      const binary = await client.requestBinary(`/attachments/${String(args.id)}/content`, {
        accept: "*/*",
      });
      return deliverFile(server, args, binary, {
        label: `Attachment ${String(args.id)}`,
        fileName: `attachment-${String(args.id)}`,
        meta: { attachment_id: args.id },
      });
    },
  );

  registerCrudTools(server, client, {
    singular: "text template",
    plural: "text templates",
    nameSingular: "text_template",
    namePlural: "text_templates",
    path: "/text-templates",
    defaultFields: SUMMARY_FIELDS.textTemplate,
    operations: ["list", "get"],
    listNotes:
      "Reusable text blocks for document headers, footers and notes. Handy for reusing your " +
      "standard payment terms or closing wording when creating a document.",
    bodyHint: "Key fields: title, text.",
  });

  registerRead(
    server,
    {
      name: "easybill_list_pdf_templates",
      title: "List PDF templates",
      description:
        "List the PDF layout templates configured in your easybill account.\n\n" +
        "Pass a template's 'id' as 'pdf_template' when creating or converting a document to " +
        "control its layout and language. The built-in values are 'DE' (German, the default) " +
        "and 'EN' (English); anything custom uses a numeric ID.\n\n" +
        "Note: this endpoint is not paginated and returns all templates at once.",
      inputSchema: {
        type: z
          .string()
          .optional()
          .describe(
            "Filter by document type, e.g. 'INVOICE' or several comma-separated ('INVOICE,OFFER').",
          ),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
    },
    async (args): Promise<ToolResult> => {
      const format = (args.response_format as ResponseFormat | undefined) ?? "markdown";
      const raw = await client.request<EasybillList<Record_> | Record_[]>("/pdf-templates", {
        query: { type: args.type as string | undefined },
      });

      // This endpoint is unpaginated and may answer with a bare array.
      const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
      const list: EasybillList<Record_> = Array.isArray(raw)
        ? { page: 1, pages: 1, limit: items.length, total: items.length, items }
        : (raw as EasybillList<Record_>);

      return buildListResponse({
        list,
        resource: "PDF templates",
        defaultFields: SUMMARY_FIELDS.pdfTemplate,
        format,
      });
    },
  );
}
