/**
 * Moving files between the caller and easybill.
 *
 * Local (stdio) mode: the server runs on the caller's machine, so downloads are
 * written to a path the caller names and uploads read from one.
 *
 * Hosted mode: the server is shared. Caller-chosen paths would let anyone read
 * or overwrite files on the server (including its token database), so file
 * paths are not offered at all: downloads come back inside the tool result and
 * uploads arrive as base64.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { BinaryResponse } from "../services/client.js";
import type { Record_, ToolResult } from "../services/format.js";
import { type Args, isHosted } from "./registry.js";

/** Largest file returned inline in hosted mode. */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
/** Largest file accepted for upload. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".xml": "application/xml",
};

export function mimeFor(fileName: string): string {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** The output argument of a download tool: a path locally, nothing when hosted. */
export function downloadShape(server: McpServer, example: string): ZodRawShape {
  if (isHosted(server)) return {};
  return {
    output_path: z
      .string()
      .min(1)
      .describe(`Absolute path to write the file to, e.g. '${example}'. Parent directory must exist.`),
  };
}

/** One sentence for a download tool's description, matching the mode. */
export function downloadNote(server: McpServer): string {
  return isHosted(server)
    ? "The file is returned inside the result (images as an image, other files as an embedded resource), " +
        `up to ${MAX_INLINE_BYTES / 1024 / 1024} MB.`
    : "The file is saved to 'output_path'; its content is NOT loaded into the conversation, so this is " +
        "safe for large files. Returns the saved path and size.";
}

/**
 * Hands a downloaded file to the caller: written to `output_path` locally,
 * returned inline when hosted.
 */
export async function deliverFile(
  server: McpServer,
  args: Args,
  binary: BinaryResponse,
  info: { label: string; fileName: string; meta: Record_ },
): Promise<ToolResult> {
  const fileName = binary.fileName ?? info.fileName;
  const meta: Record_ = {
    ...info.meta,
    bytes: binary.data.byteLength,
    content_type: binary.contentType,
    file_name: fileName,
  };
  const size = `${binary.data.byteLength.toLocaleString("en-US")} bytes, ${binary.contentType}`;

  if (!isHosted(server)) {
    const outputPath = args.output_path as string;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, binary.data);
    return {
      content: [{ type: "text", text: `Saved ${info.label} to ${outputPath} (${size}).` }],
      structuredContent: { ...meta, saved_to: outputPath },
    };
  }

  if (binary.data.byteLength > MAX_INLINE_BYTES) {
    return {
      content: [
        {
          type: "text",
          text:
            `Error: ${info.label} is ${size} — too large to return through this server ` +
            `(limit ${MAX_INLINE_BYTES / 1024 / 1024} MB). Open it in easybill directly.`,
        },
      ],
      isError: true,
    };
  }

  const mimeType = binary.contentType.split(";")[0]!.trim() || "application/octet-stream";
  const data = binary.data.toString("base64");
  const body =
    mimeType.startsWith("image/")
      ? ({ type: "image", data, mimeType } as const)
      : ({
          type: "resource",
          resource: { uri: `easybill://files/${encodeURIComponent(fileName)}`, mimeType, blob: data },
        } as const);
  return {
    content: [{ type: "text", text: `${info.label}: ${fileName} (${size}).` }, body],
    structuredContent: meta,
  };
}

/** Input arguments of an upload tool: a local path and/or base64, depending on mode. */
export function uploadShape(server: McpServer): ZodRawShape {
  const base64 = {
    content_base64: z
      .string()
      .min(4)
      .optional()
      .describe("The file content, base64-encoded."),
    file_name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("File name including extension, e.g. 'rechnung-4711.pdf'. Required with content_base64."),
  };
  if (isHosted(server)) return base64;
  return {
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute path of a local file to upload. Alternative to content_base64."),
    ...base64,
  };
}

export interface UploadFile {
  fileName: string;
  contentType: string;
  data: Buffer;
}

/** Resolves the upload arguments into file bytes, or an error message for the caller. */
export async function readUpload(server: McpServer, args: Args): Promise<UploadFile | string> {
  let data: Buffer;
  let fileName: string;

  if (typeof args.content_base64 === "string") {
    if (typeof args.file_name !== "string" || !args.file_name.trim()) {
      return "Error: 'file_name' (with extension) is required together with 'content_base64'.";
    }
    const cleaned = args.content_base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) return "Error: 'content_base64' is not valid base64.";
    data = Buffer.from(cleaned, "base64");
    fileName = args.file_name.trim();
  } else if (!isHosted(server) && typeof args.file_path === "string") {
    const { readFile } = await import("node:fs/promises");
    try {
      data = await readFile(args.file_path);
    } catch (error) {
      return `Error: cannot read ${args.file_path}: ${error instanceof Error ? error.message : String(error)}`;
    }
    fileName = typeof args.file_name === "string" && args.file_name.trim() ? args.file_name.trim() : path.basename(args.file_path);
  } else {
    return isHosted(server)
      ? "Error: pass the file as 'content_base64' together with 'file_name'."
      : "Error: pass either 'file_path' or 'content_base64' together with 'file_name'.";
  }

  if (data.byteLength === 0) return "Error: the file is empty.";
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    return `Error: the file is ${data.byteLength.toLocaleString("en-US")} bytes; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;
  }
  return { fileName, contentType: mimeFor(fileName), data };
}

/** Builds a multipart/form-data body with a single file field. */
export function multipartFile(field: string, file: UploadFile): { body: Buffer; contentType: string } {
  const boundary = `----easybill-mcp-${randomBytes(12).toString("hex")}`;
  // Quotes and line breaks would break out of the header.
  const safeName = file.fileName.replace(/["\r\n\\]/g, "_");
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${field}"; filename="${safeName}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), file.data, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8")]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
