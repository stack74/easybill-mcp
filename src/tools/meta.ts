/**
 * Server introspection.
 *
 * Makes the read-only/write mode discoverable: when writes are disabled the
 * create/update/delete tools are not registered at all, and without this tool an
 * agent could only report "no such tool" without explaining why.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  API_BASE_URL,
  CHARACTER_LIMIT,
  RATE_LIMIT_PER_MINUTE,
  SERVER_VERSION,
  WRITES_ENABLED,
} from "../constants.js";
import type { EasybillClient } from "../services/client.js";
import type { Record_, ToolResult } from "../services/format.js";
import { registerRead, registrationStats } from "./registry.js";

export function registerMetaTools(server: McpServer, client: EasybillClient): void {
  registerRead(
    server,
    {
      name: "easybill_get_server_info",
      title: "Get server info and connection status",
      description:
        "Report this MCP server's configuration and verify the easybill API credentials work.\n\n" +
        "Call this when a write tool appears to be missing, when you get authentication errors, " +
        "or when you hit rate limits — it explains the current mode and limits.\n\n" +
        "Returns: { server_version, api_base_url, writes_enabled, tools_registered, " +
        "rate_limit_per_minute, character_limit, connection } where 'connection' reports " +
        "whether a live test call to easybill succeeded.",
      inputSchema: {
        test_connection: z
          .boolean()
          .default(true)
          .describe(
            "Make one lightweight API call to verify the credentials. Costs one request against your rate limit.",
          ),
      },
    },
    async (args): Promise<ToolResult> => {

      let connection = "not tested";
      if (args.test_connection !== false) {
        try {
          // Cheapest authenticated call available: one customer group.
          await client.request<Record_>("/customer-groups", { query: { limit: 1 } });
          connection = "ok — credentials accepted by easybill";
        } catch (error) {
          const { formatApiError } = await import("../services/client.js");
          connection = `failed — ${formatApiError(error)}`;
        }
      }

      const output = {
        server_version: SERVER_VERSION,
        api_base_url: API_BASE_URL,
        writes_enabled: WRITES_ENABLED,
        tools_registered: {
          read_only: registrationStats.read,
          write: registrationStats.write,
          withheld_because_writes_disabled: registrationStats.skipped,
        },
        rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
        character_limit: CHARACTER_LIMIT,
        connection,
      };

      const modeLine = WRITES_ENABLED
        ? `Write mode is ENABLED — ${registrationStats.write} create/update/delete tools are available.`
        : `Write mode is DISABLED (read-only). ${registrationStats.skipped} create/update/delete tools ` +
          `are withheld. To enable them, set EASYBILL_ENABLE_WRITES=true in the server's environment ` +
          `and restart the MCP server.`;

      const text = [
        `# easybill MCP server v${SERVER_VERSION}`,
        "",
        modeLine,
        "",
        `- **API**: ${API_BASE_URL}`,
        `- **Read-only tools**: ${registrationStats.read}`,
        `- **Write tools**: ${registrationStats.write}`,
        `- **Rate limit (client-side throttle)**: ${RATE_LIMIT_PER_MINUTE} requests/minute`,
        `  easybill allows 10/min on PLUS and 60/min on BUSINESS — set EASYBILL_RATE_LIMIT_PER_MINUTE to match your plan.`,
        `- **Response character limit**: ${CHARACTER_LIMIT.toLocaleString("en-US")}`,
        `- **Connection**: ${connection}`,
      ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: output };
    },
  );
}
