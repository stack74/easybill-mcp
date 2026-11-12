/**
 * Server-level instructions, sent to the client during initialization.
 *
 * Individual tool descriptions explain single endpoints well, but they cannot tell
 * an agent where to START. Without this, a request like "make an offer for this
 * inquiry" tends to open with a broad easybill_list_documents call — wasted requests
 * against a 10/min rate limit, and the wrong first question.
 *
 * Keep this focused on ordering and decision points, not field reference.
 */

export const SERVER_INSTRUCTIONS = `easybill is a German invoicing and accounting system. This server exposes its REST API.

# Before you start

Two rules that prevent most mistakes:

1. **All monetary values are integers in CENTS.** 1999 means 19.99 EUR. Never send decimal euros.
   Times in time tracking are in minutes.
2. **The rate limit is low** — 10 requests/minute on easybill's Professional plan, 60 on Premium.
   Never "browse" or "explore" the data to orient yourself. Go straight to the specific
   filtered call that answers the question. A broad list costs the same as a precise one
   but tells you less.

# Workflows

## Creating an offer or invoice for someone (e.g. from an inbound inquiry)

Do these in order. Do NOT start by listing documents — that tells you nothing about
whether the customer exists.

1. **Find the customer**: \`easybill_find_customer\` with the company or person name.
   - One certain match -> use its \`id\`.
   - Several matches -> ask the user which one. Do not guess.
   - No match -> continue to step 2.
2. **Create the customer** (only if it does not exist): \`easybill_create_customer\`.
   Required: \`last_name\` AND \`company_name\` — pass an empty string for whichever does
   not apply. Include address and email when you have them.
3. **Create the document**: \`easybill_create_document\` with \`customer_id\`, \`type\`
   (\`OFFER\` for a quote, \`INVOICE\` for a bill), and \`items\` for the line items.
   This produces a **draft** — it has no official number yet and is still editable.
4. **Review with the user** before finalising. Show them the amounts and line items.
5. **Complete it**: \`easybill_complete_document\` — easybill then assigns the official
   document number and locks the document.
6. **Send it** only if asked: \`easybill_send_document\`. This dispatches real email, fax
   or post to a real recipient. Always confirm the recipient first.

When an inquiry does not specify prices, do not invent them. Look up the relevant articles
with \`easybill_list_positions\` and reference them by \`position_id\` in the line items, or
ask the user what to charge.

## Answering a question about existing data

Pick the one filtered call that answers it:

- Unpaid invoices -> \`easybill_list_documents\` with \`type='INVOICE'\`, \`paid_at='null'\`
- Revenue in a period -> \`easybill_list_documents\` with \`type='INVOICE'\`,
  \`document_date='2026-01-01,2026-12-31'\`
- One customer's history -> \`easybill_list_documents\` with \`customer_id=<id>\`
  (resolve the id via \`easybill_find_customer\` first)
- Real invoices only -> add \`is_draft='0'\` and \`cancel_id='null'\` to exclude drafts and
  cancelled documents
- Unbilled work -> \`easybill_list_time_trackings\`, then keep entries where \`cleared_at\` is null

Sum money in cents and divide by 100 only when presenting the result.

## Recording a payment

\`easybill_create_document_payment\` with \`document_id\` and \`amount\` (in cents). This is what
marks an invoice as paid. Partial payments are fine — easybill tracks the running total in
the document's \`paid_amount\`.

## Voiding an invoice

Use \`easybill_cancel_document\`, which creates a proper STORNO document. Do **not** use
\`easybill_delete_document\` on a completed invoice — that is not legally valid, and easybill
will usually refuse it anyway.

# Modes

If a create/update/delete tool seems to be missing, the server is running in read-only mode.
Call \`easybill_get_server_info\` to confirm and to see how to enable writes. Do not tell the
user a write failed for another reason without checking this first.

# Context

\`Document\` has 69 fields and \`Customer\` 79. List tools return a compact subset by default.
Pass \`fields\` to pick specific columns, or \`fields: ["all"]\` when you genuinely need
everything. Prefer narrow \`fields\` and a small \`limit\` over paging through bulk data.`;
