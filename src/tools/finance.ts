/** Payments recorded against documents. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUMMARY_FIELDS } from "../constants.js";
import { dateFilter, multiFilter } from "../schemas/common.js";
import type { EasybillClient } from "../services/client.js";
import { registerCrudTools } from "./crud.js";

export function registerFinanceTools(server: McpServer, client: EasybillClient): void {
  registerCrudTools(server, client, {
    singular: "document payment",
    plural: "document payments",
    nameSingular: "document_payment",
    namePlural: "document_payments",
    path: "/document-payments",
    defaultFields: SUMMARY_FIELDS.payment,
    operations: ["list", "get", "create", "delete"],
    listNotes:
      "Payments booked against documents. Recording a payment is what marks an invoice as paid — " +
      "it updates the document's 'paid_amount' and 'paid_at'.\n" +
      "To find open invoices instead, use easybill_list_documents with type='INVOICE' and paid_at='null'.\n" +
      "Amounts are integers in cents (150 = 1.50 EUR).",
    bodyHint: `Required: document_id and amount.

IMPORTANT: 'amount' is an INTEGER IN CENTS — 1999 means 19.99 EUR.

- document_id (integer): the invoice being paid.
- amount (integer, CENTS): the amount received. A partial payment is fine; easybill
  tracks the running total in the document's 'paid_amount'.
- payment_at (string): date of payment, YYYY-MM-DD (Europe/Berlin). Defaults to now.
- type (string): free-text payment method, e.g. 'Überweisung', 'PayPal', 'Lastschrift'.
- reference (string): bank reference / transaction ID, useful for reconciliation.
- notice (string): internal note.
- is_overdue_fee (boolean): mark this as a late-payment fee rather than a payment on the invoice.`,
    deleteNotes:
      "Removing a payment reopens the invoice by reducing its paid_amount. Use this to undo a " +
      "mis-booked payment.",
    filters: {
      document_id: multiFilter("Filter by the document (invoice) the payment belongs to."),
      reference: multiFilter("Filter by bank reference / transaction ID."),
      payment_at: dateFilter("payment date"),
    },
  });
}
