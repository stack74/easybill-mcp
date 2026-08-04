#!/usr/bin/env node
/**
 * MCP server for the easybill REST API.
 *
 * Exposes invoices and other documents, customers, contacts, the article
 * catalogue, payments, projects, time tracking, attachments and templates.
 *
 * Transport: stdio (local). Never log to stdout — it carries the MCP protocol.
 *
 * Environment:
 *   EASYBILL_API_KEY                (required)
 *   EASYBILL_ENABLE_WRITES          (optional, default off — read-only)
 *   EASYBILL_RATE_LIMIT_PER_MINUTE  (optional, default 60)
 *   EASYBILL_CHARACTER_LIMIT        (optional, default 25000)
 *   EASYBILL_TIMEOUT_MS             (optional, default 30000)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  API_BASE_URL,
  RATE_LIMIT_PER_MINUTE,
  SERVER_NAME,
  SERVER_VERSION,
  WRITES_ENABLED,
} from "./constants.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { EasybillClient, formatApiError } from "./services/client.js";
import type { EasybillList, Record_ } from "./services/format.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerFileTools } from "./tools/files.js";
import { registerFinanceTools } from "./tools/finance.js";
import { registerMetaTools } from "./tools/meta.js";
import { registrationStats } from "./tools/registry.js";
import { registerSearchTools } from "./tools/search.js";
import { registerWorkTools } from "./tools/work.js";

const USAGE = `${SERVER_NAME} v${SERVER_VERSION}

An MCP server for the easybill REST API (https://www.easybill.de/api/).
Speaks the Model Context Protocol over stdio; run it from an MCP client, not by hand.

Required environment:
  EASYBILL_API_KEY                Your easybill API key.
                                  Get one in easybill under Einstellungen -> App-Center -> API.

Optional environment:
  EASYBILL_ENABLE_WRITES=true     Enable create/update/delete tools. Default: read-only.
  EASYBILL_RATE_LIMIT_PER_MINUTE  Client-side throttle. Use 10 for PLUS, 60 for BUSINESS.
  EASYBILL_CHARACTER_LIMIT        Max characters per response before truncation (default 25000).
  EASYBILL_TIMEOUT_MS             HTTP timeout in milliseconds (default 30000).
  EASYBILL_MAX_RETRIES            Retries on 429/5xx (default 3).

Flags:
  --help, -h        Show this help.
  --version, -v     Print the version.
  --selftest        Make a few READ-ONLY calls against easybill and report what came back.
                    Verifies credentials and connectivity without an MCP client.

Register with Claude Code:
  claude mcp add easybill --env EASYBILL_API_KEY=your_key -- node ${process.argv[1] ?? "dist/index.js"}
`;

/**
 * Read-only smoke test against the live API.
 *
 * Prints to stdout because this mode is meant to be run by a human in a terminal,
 * never inside an MCP session.
 */
async function selftest(client: EasybillClient): Promise<number> {
  const log = (line: string): void => void process.stdout.write(`${line}\n`);

  log(`${SERVER_NAME} v${SERVER_VERSION} self-test`);
  log(`API: ${API_BASE_URL}`);
  log(`Throttle: ${RATE_LIMIT_PER_MINUTE} req/min | writes ${WRITES_ENABLED ? "ENABLED" : "disabled"}`);
  log("");

  // Ordered cheapest-first so an auth failure costs a single request.
  const probes: { label: string; path: string; query?: Record<string, string | number> }[] = [
    { label: "Auth check (customer groups)", path: "/customer-groups", query: { limit: 1 } },
    { label: "Customers", path: "/customers", query: { limit: 3 } },
    { label: "Invoices", path: "/documents", query: { limit: 3, type: "INVOICE" } },
    { label: "Unpaid invoices", path: "/documents", query: { limit: 1, type: "INVOICE", paid_at: "null" } },
    { label: "Articles (positions)", path: "/positions", query: { limit: 3 } },
  ];

  let failures = 0;
  for (const probe of probes) {
    try {
      const list = await client.request<EasybillList<Record_>>(probe.path, {
        ...(probe.query ? { query: probe.query } : {}),
      });
      const total = list?.total ?? 0;
      const sample = list?.items?.[0];
      const label =
        sample === undefined
          ? "(none in account)"
          : String(
              sample.display_name ?? sample.number ?? sample.name ?? sample.title ?? `id ${String(sample.id)}`,
            );
      log(`  OK    ${probe.label}: total=${total}  first=${label}`);
    } catch (error) {
      failures++;
      log(`  FAIL  ${probe.label}: ${formatApiError(error)}`);
      // A bad key fails every probe — stop rather than burning the rate limit.
      if (failures === 1 && probe.path === "/customer-groups") {
        log("\nAuth failed on the first call, skipping the rest.");
        break;
      }
    }
  }

  log("");
  if (failures === 0) {
    log("All probes passed. The server is ready to register with an MCP client.");
    return 0;
  }
  log(`${failures} probe(s) failed — see the messages above.`);
  return 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const apiKey = process.env.EASYBILL_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      "ERROR: EASYBILL_API_KEY environment variable is required.\n" +
        "Create an API key in easybill under Einstellungen -> App-Center -> API,\n" +
        "then pass it to the server, e.g.:\n" +
        "  claude mcp add easybill --env EASYBILL_API_KEY=your_key -- node /path/to/dist/index.js\n\n" +
        "Run with --help for all options.",
    );
    process.exit(1);
  }

  const client = new EasybillClient(apiKey);

  if (process.argv.includes("--selftest")) {
    process.exitCode = await selftest(client);
    return;
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Customer lookup registers first: resolving who the customer is comes before
  // anything else in almost every real task.
  registerSearchTools(server, client);
  registerCustomerTools(server, client);
  registerDocumentTools(server, client);
  registerCatalogTools(server, client);
  registerFinanceTools(server, client);
  registerWorkTools(server, client);
  registerFileTools(server, client);
  registerMetaTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is the protocol channel.
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} ready on stdio | ` +
      `${registrationStats.read} read + ${registrationStats.write} write tools | ` +
      `writes ${WRITES_ENABLED ? "ENABLED" : "disabled (read-only)"}` +
      (WRITES_ENABLED ? "" : ` — ${registrationStats.skipped} write tools withheld`) +
      ` | throttle ${RATE_LIMIT_PER_MINUTE} req/min`,
  );
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
