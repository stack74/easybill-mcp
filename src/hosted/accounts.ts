/**
 * Hosted mode: the account overview tool and the instructions that explain
 * accounts to the model.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolResult } from "../services/format.js";
import { registerRead } from "../tools/registry.js";
import type { TenantConfig } from "./config.js";
import type { ConnectionRow } from "./store.js";

type Status = "connected" | "expired" | "not_connected";

function statusOf(connection: ConnectionRow | undefined): Status {
  if (!connection) return "not_connected";
  return connection.broken_reason ? "expired" : "connected";
}

export function accountInstructions(tenants: TenantConfig[], connections: ConnectionRow[]): string {
  const usable = tenants.filter((t) => statusOf(connections.find((c) => c.tenant_id === t.id)) === "connected");
  const lines = [
    "# Accounts",
    "",
    "This server reaches several easybill accounts (companies). Every tool takes an `account` argument.",
  ];
  if (usable.length === 0) {
    lines.push(
      "",
      "No account is connected for this user yet. Call `easybill_list_accounts` and give the user the link to connect one.",
    );
  } else {
    lines.push(
      "",
      "Connected for this user:",
      ...usable.map((t) => `- \`${t.id}\` = ${t.name} (${t.writes ? "read & write" : "read-only"})`),
      "",
      "- Customers, documents, IDs and numbers belong to ONE account. Never reuse an ID from one account in a call on another.",
      "- If the request does not make clear which account is meant and more than one is connected, ask the user.",
      "- If the user needs an account that is not connected, or a call reports an expired connection, call " +
        "`easybill_list_accounts` and give them the link.",
    );
  }
  return lines.join("\n");
}

export function registerAccountTools(
  server: McpServer,
  deps: { tenants: TenantConfig[]; connections: ConnectionRow[]; manageLink: () => string },
): void {
  registerRead(
    server,
    {
      name: "easybill_list_accounts",
      title: "List easybill accounts and connection status",
      description:
        "List the easybill accounts (companies) this server can reach, which of them the user has connected, " +
        "and whether each allows writes. Also returns a link where the user connects more accounts or " +
        "reconnects an expired one with their own easybill login.\n\n" +
        "Call this when the user asks which accounts are available, names an account that is not connected, " +
        "or a tool reports an expired connection. Give the user the link — it is valid for 30 minutes. " +
        "Costs no easybill request.",
      inputSchema: {},
      accountless: true,
    },
    async (): Promise<ToolResult> => {
      const byTenant = new Map(deps.connections.map((c) => [c.tenant_id, c]));
      const accounts = deps.tenants.map((t) => {
        const connection = byTenant.get(t.id);
        return {
          account: t.id,
          name: t.name,
          status: statusOf(connection),
          writes: t.writes,
          ...(connection?.login_label ? { connected_as: connection.login_label } : {}),
        };
      });
      const link = deps.manageLink();

      const label: Record<Status, string> = {
        connected: "connected",
        expired: "EXPIRED — reconnect via the link",
        not_connected: "not connected",
      };
      const text = [
        "# easybill accounts",
        "",
        ...accounts.map(
          (a) =>
            `- **${a.name}** (\`${a.account}\`): ${label[a.status]}` +
            `${a.connected_as ? ` as ${a.connected_as}` : ""}, ${a.writes ? "read & write" : "read-only"}`,
        ),
        "",
        `Connect or reconnect accounts here (valid 30 minutes): ${link}`,
        "A newly connected account works from the next tool call on — pass its id as `account` even if an " +
          "older tool list does not show it yet.",
      ].join("\n");

      return { content: [{ type: "text", text }], structuredContent: { accounts, connect_url: link } };
    },
  );
}
