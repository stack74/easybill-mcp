/** Customers, their contact persons, and customer groups. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUMMARY_FIELDS } from "../constants.js";
import { dateFilter, multiFilter } from "../schemas/common.js";
import type { EasybillClient } from "../services/client.js";
import { registerCrudTools } from "./crud.js";

const CUSTOMER_BODY_HINT = `Required: last_name AND company_name (send an empty string for whichever does not apply —
a company customer typically has company_name set and last_name empty, and vice versa).

Key fields:
- company_name, salutation, title, first_name, last_name
- street, suffix_1, suffix_2, zip_code, city, state, country (ISO 2-letter, e.g. 'DE')
- emails (array of strings), phone_1, phone_2, mobile, fax, internet
- number (string): your own customer number. easybill assigns one if omitted.
- group_id (integer): customer group. List them with easybill_list_customer_groups.
- vat_identifier (string): VAT ID / USt-IdNr., needed for EU B2B reverse-charge invoicing.
- tax_number (string), personal (boolean), note, info_1, info_2
- Delivery address: delivery_company_name, delivery_first_name, delivery_last_name,
  delivery_street, delivery_zip_code, delivery_city, delivery_country
- Bank details: bank_name, bank_iban, bank_bic, bank_account_owner
- SEPA: sepa_agreement, sepa_agreement_date, sepa_mandate_reference
- grace_period (integer): default payment term in days for this customer's invoices
- cash_discount + cash_discount_type ('PERCENT'|'AMOUNT'), sale_price_level (1-10)
- archived (boolean)

Monetary values are integers in cents (150 = 1.50 EUR).`;

const CONTACT_BODY_HINT = `Required: street AND city.

Key fields: salutation, title, first_name, last_name, company_name, department,
street, suffix_1, suffix_2, zip_code, city, state, country (ISO code),
emails (array of strings), phone_1, phone_2, mobile, fax, note, personal (boolean).

Contacts are the individual people at a customer. A document can reference one
via its 'contact_id' field.`;

export function registerCustomerTools(server: McpServer, client: EasybillClient): void {
  registerCrudTools(server, client, {
    singular: "customer",
    plural: "customers",
    nameSingular: "customer",
    namePlural: "customers",
    path: "/customers",
    defaultFields: SUMMARY_FIELDS.customer,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes:
      "NOTE: easybill has no fuzzy full-text customer search. The filters below match exact " +
      "values (though each accepts several comma-separated values). To find a customer by a " +
      "partial name, filter on company_name or last_name with the exact spelling, or page " +
      "through the list and match locally.",
    bodyHint: CUSTOMER_BODY_HINT,
    deleteNotes:
      "Deleting a customer does not delete their documents, but those documents keep only " +
      "a stored snapshot of the customer data.",
    filters: {
      company_name: multiFilter("Filter by exact company name."),
      last_name: multiFilter("Filter by exact last name."),
      first_name: multiFilter("Filter by exact first name."),
      emails: multiFilter("Filter by email address."),
      number: multiFilter("Filter by your customer number."),
      country: multiFilter("Filter by country (ISO 2-letter code, e.g. 'DE' or 'DE,AT,CH')."),
      zip_code: multiFilter("Filter by postal code."),
      group_id: multiFilter("Filter by customer group ID."),
      additional_group_id: multiFilter("Filter by an additional customer group ID."),
      created_at: dateFilter("creation date"),
    },
  });

  registerCrudTools(server, client, {
    singular: "contact",
    plural: "contacts",
    nameSingular: "contact",
    namePlural: "contacts",
    path: "/contacts",
    defaultFields: SUMMARY_FIELDS.contact,
    operations: ["list", "get", "create", "update", "delete"],
    listNotes: "Contacts are always scoped to one customer, so 'customer_id' is required.",
    bodyHint: CONTACT_BODY_HINT,
    parent: {
      param: "customer_id",
      path: (id) => `/customers/${String(id)}`,
      description:
        "The numeric ID of the customer whose contacts these are. Find it with easybill_list_customers.",
    },
  });

  registerCrudTools(server, client, {
    singular: "customer group",
    plural: "customer groups",
    nameSingular: "customer_group",
    namePlural: "customer_groups",
    path: "/customer-groups",
    defaultFields: SUMMARY_FIELDS.customerGroup,
    operations: ["list", "get"],
    listNotes:
      "Customer groups classify customers and can carry their own pricing level. " +
      "Use a group's 'id' as 'group_id' when creating or filtering customers.",
    bodyHint: "Key fields: name, display_name, description, number.",
  });
}
