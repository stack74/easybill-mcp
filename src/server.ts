/**
 * Builds one McpServer with every tool registered.
 *
 * Shared by both transports: stdio builds one for the process, HTTP builds one
 * per request with that session's accounts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, WRITES_ENABLED } from "./constants.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import type { ApiClient } from "./services/client.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerFileTools } from "./tools/files.js";
import { registerFinanceTools } from "./tools/finance.js";
import { registerIncomingDocumentTools } from "./tools/incoming.js";
import { registerMetaTools } from "./tools/meta.js";
import { type ServerContext, setServerContext } from "./tools/registry.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWorkTools } from "./tools/work.js";

export interface CreateServerOptions {
  /** Defaults to EASYBILL_ENABLE_WRITES. */
  writesEnabled?: boolean;
  /** Hosted mode: the session's accounts. Adds an `account` argument to every tool. */
  accounts?: ServerContext["accounts"];
  /** Appended to the server instructions (hosted mode explains accounts here). */
  extraInstructions?: string;
  /** Registers additional tools after the standard set (hosted mode: account tools). */
  extraTools?: (server: McpServer) => void;
  /** Server icons announced in the MCP initialize response (hosted mode). */
  icons?: Icon[];
}

export function createEasybillServer(
  client: ApiClient,
  options: CreateServerOptions = {},
): { server: McpServer; context: ServerContext } {
  const instructions = options.extraInstructions
    ? `${SERVER_INSTRUCTIONS}\n\n${options.extraInstructions}`
    : SERVER_INSTRUCTIONS;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, ...(options.icons?.length ? { icons: options.icons } : {}) },
    { instructions },
  );

  const context: ServerContext = {
    writesEnabled: options.writesEnabled ?? WRITES_ENABLED,
    stats: { read: 0, write: 0, skipped: 0 },
    ...(options.accounts ? { accounts: options.accounts } : {}),
  };
  setServerContext(server, context);

  // Account tools first in hosted mode: knowing which account to use comes
  // before anything else.
  options.extraTools?.(server);
  // Customer lookup registers next: resolving who the customer is comes before
  // anything else in almost every real task.
  registerSearchTools(server, client);
  registerCustomerTools(server, client);
  registerDocumentTools(server, client);
  registerCatalogTools(server, client);
  registerFinanceTools(server, client);
  registerWorkTools(server, client);
  registerFileTools(server, client);
  registerIncomingDocumentTools(server, client);
  registerMetaTools(server, client);

  return { server, context };
}
