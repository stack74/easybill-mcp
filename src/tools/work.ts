/** Projects and time tracking. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SUMMARY_FIELDS } from "../constants.js";
import { dateFilter, multiFilter } from "../schemas/common.js";
import type { ApiClient } from "../services/client.js";
import { registerCrudTools } from "./crud.js";

export function registerWorkTools(server: McpServer, client: ApiClient): void {
  registerCrudTools(server, client, {
    singular: "project",
    plural: "projects",
    nameSingular: "project",
    namePlural: "projects",
    path: "/projects",
    defaultFields: SUMMARY_FIELDS.project,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes:
      "Projects group documents and tracked time under a customer engagement, with an optional " +
      "budget. 'consumed_amount' and 'consumed_time' show progress against " +
      "'budget_amount' and 'budget_time' — useful for budget-burn questions.\n" +
      "Amounts are integers in cents; times are in minutes.",
    bodyHint: `Required: name.

IMPORTANT: monetary values are INTEGERS IN CENTS (150 = 1.50 EUR); times are in MINUTES.

- name (string): project name.
- customer_id (integer): the customer this project belongs to.
- status ('OPEN'|'DONE'|'CANCEL'): defaults to OPEN.
- due_at (string): deadline, YYYY-MM-DD.
- hourly_rate (integer, CENTS): billing rate used for tracked time.
- budget_amount (integer, CENTS): budget cap in money.
- budget_time (integer, MINUTES): budget cap in time.
- budget_notify_frequency (string): when to warn about budget consumption.
- note (string).

Read-only: consumed_amount, consumed_time.`,
    filters: {
      customer_id: multiFilter("Filter by customer ID."),
      status: z
        .enum(["OPEN", "DONE", "CANCEL"])
        .optional()
        .describe("Filter by project status."),
    },
  });

  registerCrudTools(server, client, {
    singular: "time tracking entry",
    plural: "time tracking entries",
    nameSingular: "time_tracking",
    namePlural: "time_trackings",
    path: "/time-trackings",
    defaultFields: SUMMARY_FIELDS.timeTracking,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes:
      "Tracked working time, optionally tied to a project and an article. 'timer_value' is the " +
      "tracked duration in MINUTES and 'hourly_rate' is in cents.\n" +
      "'cleared_at' is set once the entry has been billed — entries with cleared_at = null are " +
      "still unbilled, which is what you want when preparing an invoice.",
    bodyHint: `Required: description.

IMPORTANT: 'timer_value' is in MINUTES; 'hourly_rate' is an INTEGER IN CENTS (150 = 1.50 EUR).

- description (string): what was worked on. Appears as the invoice line item text.
- timer_value (integer, MINUTES): duration. 90 means one and a half hours.
- date_from_at (string): start, 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (Europe/Berlin).
- date_thru_at (string): end, same format.
- hourly_rate (integer, CENTS): rate for this entry. Defaults to 0, and the project rate applies.
- project_id (integer): the project to bill this against.
- position_id (integer): the catalogue article representing this kind of work.
- number (string): free-form reference of your choosing.
- note (string): internal note.
- cleared_at (string): set this once the time has been invoiced.`,
    filters: {
      project_id: multiFilter("Filter by project ID."),
      login_id: multiFilter("Filter by the easybill login (employee) that tracked the time."),
      date_from_at: dateFilter("start date"),
      date_thru_at: dateFilter("end date"),
    },
  });
}
