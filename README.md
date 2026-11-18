# easybill MCP Server

An [MCP](https://modelcontextprotocol.io) server for the [easybill REST API](https://www.easybill.de/api/).
Gives any MCP-capable assistant — Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Zed,
Codex CLI, Gemini CLI, Cline — access to your invoices, customers, article catalogue, payments,
projects and tracked time.

Built on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
(TypeScript), talking stdio.

- **64 tools** across 13 easybill resources (65 in hosted mode)
- **Read-only by default** — create/update/delete tools stay unregistered unless you opt in
- **Workflow-aware** — ships server instructions so the agent resolves the customer before
  writing a document, instead of guessing where to start
- **Fuzzy customer search** the easybill API itself does not offer
- **Self-throttling** to respect easybill's 10–60 requests/minute cap
- **Context-aware responses** — compact field sets, pagination metadata, automatic truncation

---

## Setup

### 1. Get an easybill API key

In easybill: **Einstellungen → App-Center → API**. Create a key and copy it.

### 2. Register it with your client

This is a plain stdio MCP server published on npm, so any MCP client can run it with `npx` —
no clone, no build, no global install:

```bash
npx -y easybill-mcp
```

Configuration is entirely through environment variables (full list under
[Configuration](#configuration)). Two matter now:

- Leave `EASYBILL_ENABLE_WRITES` unset to start **read-only**.
- Set `EASYBILL_RATE_LIMIT_PER_MINUTE` to **10** on easybill's Professional plan or **60** on Premium (Free and Starter have no API access).

Most clients use the same JSON shape under an `mcpServers` key:

```json
{
  "mcpServers": {
    "easybill": {
      "command": "npx",
      "args": ["-y", "easybill-mcp"],
      "env": {
        "EASYBILL_API_KEY": "your_api_key_here",
        "EASYBILL_RATE_LIMIT_PER_MINUTE": "10"
      }
    }
  }
}
```

Where that block goes:

| Client | Config location |
|---|---|
| **Claude Desktop** | Settings → Developer → Edit Config, or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **Cursor** | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project) |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |
| **Cline / Roo Code** | MCP Servers panel → Configure MCP Servers (`cline_mcp_settings.json`) |
| **Gemini CLI** | `~/.gemini/settings.json` |
| **Claude Code** | `claude mcp add`, see below |
| **VS Code / Copilot** | `.vscode/mcp.json`, different key — see below |
| **Zed** | `settings.json` → `context_servers`, see below |
| **Codex CLI** | `~/.codex/config.toml`, TOML instead of JSON — see below |

> **Windows:** if a client fails to start `npx`, use `"command": "cmd"` with
> `"args": ["/c", "npx", "-y", "easybill-mcp"]`.

#### Claude Code

```bash
claude mcp add easybill \
  --env EASYBILL_API_KEY=your_api_key_here \
  --env EASYBILL_RATE_LIMIT_PER_MINUTE=10 \
  -- npx -y easybill-mcp
```

`claude mcp add` does not overwrite an existing entry — to change the environment later,
`claude mcp remove easybill -s local` first, then add it again.

#### VS Code (GitHub Copilot agent mode)

VS Code uses `servers`, not `mcpServers`, and can prompt for the key instead of storing it
in the file. Put this in `.vscode/mcp.json` (workspace) or open **MCP: Open User
Configuration**:

```json
{
  "inputs": [
    { "id": "easybill_key", "type": "promptString", "description": "easybill API key", "password": true }
  ],
  "servers": {
    "easybill": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "easybill-mcp"],
      "env": {
        "EASYBILL_API_KEY": "${input:easybill_key}",
        "EASYBILL_RATE_LIMIT_PER_MINUTE": "10"
      }
    }
  }
}
```

#### Zed

In `settings.json`:

```json
{
  "context_servers": {
    "easybill": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "easybill-mcp"],
      "env": {
        "EASYBILL_API_KEY": "your_api_key_here",
        "EASYBILL_RATE_LIMIT_PER_MINUTE": "10"
      }
    }
  }
}
```

#### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.easybill]
command = "npx"
args = ["-y", "easybill-mcp"]
env = { EASYBILL_API_KEY = "your_api_key_here", EASYBILL_RATE_LIMIT_PER_MINUTE = "10" }
```

#### Hosted clients that only speak remote MCP

For claude.ai and other remote-only clients, run the server in **hosted mode** (see
"Hosted mode" below): one connector for the whole company, each person connects the easybill
accounts they use with their personal API key.

For a quick single-user experiment you can instead bridge the stdio server locally:

```bash
npx -y supergateway --stdio "npx -y easybill-mcp"
```

Only do this if you understand the exposure: anything that reaches that endpoint reaches your
accounting data. Keep it bound to localhost or behind a tunnel with authentication, and never
run the bridge with writes enabled unless the endpoint is protected.

### 3. Verify the connection

Ask the assistant to call `easybill_get_server_info`. It reports the mode, the limits and
whether easybill accepted the credentials:

```json
{
  "server_version": "1.0.1",
  "writes_enabled": false,
  "tools_registered": { "read_only": 28, "write": 0, "withheld_because_writes_disabled": 26 },
  "rate_limit_per_minute": 10,
  "connection": "ok — credentials accepted by easybill"
}
```

### 4. Enable writes, once you trust it

Add `EASYBILL_ENABLE_WRITES=true` to the server's environment:

```bash
claude mcp add easybill \
  --env EASYBILL_API_KEY=your_api_key_here \
  --env EASYBILL_RATE_LIMIT_PER_MINUTE=10 \
  --env EASYBILL_ENABLE_WRITES=true \
  -- npx -y easybill-mcp
```

The 26 write tools are registered at startup, so the change only takes effect once the client
restarts the server process — editing the config in a running session is not enough. Confirm
with `easybill_get_server_info`: `writes_enabled` must read `true`.

---

## Running from a local clone

For development, or to run a version you have not published:

```bash
git clone https://github.com/stack74/easybill-mcp.git
cd easybill-mcp
npm install
npm run build
```

Then point the client at the built entry point instead of `npx` — `"command": "node"`,
`"args": ["/absolute/path/to/easybill-mcp/dist/index.js"]`, same `env` block. Or straight from
GitHub without cloning, which is slower because it compiles TypeScript on install via the
`prepare` script and needs a toolchain:

```bash
npx -y github:stack74/easybill-mcp
```

### Test locally first

Copy `.env.example` to `.env`, put your key in it, then run the read-only self-test:

```bash
cp .env.example .env
$EDITOR .env
npm run smoke
```

It makes five read-only calls and prints what came back:

```
easybill-mcp-server v1.x.y self-test
API: https://api.easybill.de/rest/v1
Throttle: 60 req/min | writes disabled

  OK    Auth check (customer groups): total=2  first=Stammkunden
  OK    Customers: total=42  first=Example GmbH
  OK    Invoices: total=128  first=RE-2026-0001
  OK    Unpaid invoices: total=7  first=RE-2026-0117
  OK    Articles (positions): total=95  first=ART-001

All probes passed. The server is ready to register with an MCP client.
```

(Numbers above are illustrative — you will see your own account's totals.)

On a bad key it fails on the first call and stops, so it never burns your rate limit.

To poke at individual tools interactively:

```bash
npm run inspect     # MCP Inspector, loads .env
```

> **Note:** `.env` is only read by these npm scripts, via Node's `--env-file`. The server
> itself reads plain environment variables — when you register it with an MCP client, pass
> the key through the client's config, not via `.env`.

### Publishing to npm

```bash
npm login                  # once, needs an npmjs.com account
npm run build && npm run smoke
npm publish                # unscoped packages are public by default
```

Verify what ships before you publish — `npm pack --dry-run` lists the tarball contents.
Only `dist/`, `README.md`, `LICENSE` and `package.json` are included; `src/` and `.env`
are not.

For later releases bump the version first (`npm version patch|minor|major`), which also
creates a git tag. npm does not allow republishing an existing version.

---

## Hosted mode (claude.ai connector, several easybill accounts)

`easybill-mcp --http` runs the server as a remote MCP endpoint (Streamable HTTP) for a whole
company:

1. Someone adds the connector in claude.ai (or any OAuth-capable MCP client). Only known redirect
   URIs may register (see [Security](#security-hosted-mode)).
2. The client opens this server's **connect page**. It names the app that asks and where the
   access will go, and lists the easybill accounts from your
   tenant configuration; the person clicks *Verbinden* on each account they have access to and
   pastes **their personal easybill API key** (easybill: user icon → *Profil und Einstellungen*
   → *API Key*). The server checks it against easybill before storing it.
3. *Fertig – zurück zu Claude* completes the client's OAuth flow.

Every tool then takes an `account` argument (`easybill_list_accounts` shows the status and
hands out a link to connect more accounts or replace a key). Keys are stored AES-GCM encrypted
in SQLite. A key easybill rejects later (regenerated, login removed) is marked and the model
hands out the link to replace it.

This server is the OAuth authorization server for the MCP client (claude.ai); easybill itself
only sees API-key requests. An API key does not say which easybill account it belongs to, so on
the first connection of a tenant the server remembers the account's login IDs (from `/logins`)
and refuses later keys from a different account, including a key that already belongs to another
configured tenant.

**easybill OAuth instead of API keys** (`EASYBILL_CONNECT_MODE=oauth`): people log in at easybill
instead of pasting a key. easybill only allows dynamic client registration for an allowlist of
redirect URIs (claude.ai and similar), so this mode needs an OAuth client issued by easybill for
`<EASYBILL_PUBLIC_URL>/connect/callback` (`EASYBILL_OAUTH_CLIENT_ID` / `_SECRET`).

### Tenant configuration

```json
{
  "tenants": [
    { "id": "firma-a", "name": "Firma A GmbH", "plan": "PREMIUM", "writes": true },
    { "id": "firma-b", "name": "Firma B GmbH", "plan": "PROFESSIONAL", "writes": false }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Slug the model passes as `account`. |
| `name` | Shown on the connect page and to the model. |
| `plan` | `PROFESSIONAL` (10 req/min) or `PREMIUM` (60 req/min); the former names `PLUS` / `BUSINESS` work too. Free and Starter have no API access. Throttle shared by everyone on the account. Or set `rate_limit_per_minute`. |
| `writes` | `true` registers create/update/delete for this account and requests write scopes from easybill. Default read-only scopes. |
| `scopes` | Optional override of the easybill OAuth scopes. |
| `match` | OAuth mode only: `{ "<claim>": "<value>" }` checked against easybill's access-token claims, so a login of the wrong company is refused. The server logs the claims of every new connection. |

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `EASYBILL_PUBLIC_URL` | — | **Required.** Public https base URL. The connector URL is `<this>/mcp`. |
| `EASYBILL_MCP_SECRET` | — | **Required.** ≥ 32 characters; encrypts stored tokens and signs the browser cookie. Changing it invalidates all connections. |
| `EASYBILL_TENANTS_FILE` / `EASYBILL_TENANTS` | — | **Required.** Path to the tenant JSON, or the JSON inline. |
| `EASYBILL_DB_PATH` | `./data/easybill-mcp.sqlite` | SQLite file. Put it on a persistent volume. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |
| `EASYBILL_CF_ACCESS_TEAM_DOMAIN` / `EASYBILL_CF_ACCESS_AUD` | — | Put the connect pages behind Cloudflare Access: team domain (e.g. `acme` or `acme.cloudflareaccess.com`) and the Access application's AUD tag. `/connect/*` then requires a valid Access token, checked by the server itself. |
| `EASYBILL_ICON_PATH` | — | Path to an `.svg`, `.png` or `.ico` file (e.g. a file mount in your hosting platform). Served as `/favicon.ico` and `/favicon.<ext>`, linked from the pages and announced as the MCP server icon. claude.ai shows the domain's favicon next to a custom connector. |
| `EASYBILL_ALLOWED_REDIRECT_URIS` | — | Comma-separated redirect URIs MCP clients may register, **in addition to** the built-in ones (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`). `:*` matches any port; a pattern without a path matches any path on that origin. |
| `EASYBILL_DEFAULT_REDIRECT_URIS` | `true` | `false` drops the built-in redirect URIs, so only `EASYBILL_ALLOWED_REDIRECT_URIS` are allowed (the server refuses to start if that leaves none). |
| `EASYBILL_CONNECT_MODE` | `apikey` (`oauth` if a client ID is set) | How people connect easybill accounts. |
| `EASYBILL_OAUTH_CLIENT_ID` / `_SECRET` | — | OAuth mode: the client easybill issued for this server. |
| `EASYBILL_OAUTH_ISSUER` | `https://api.easybill.de` | OAuth mode: easybill's OAuth issuer. |
| `EASYBILL_MCP_ACCESS_TOKEN_TTL` | `3600` | Lifetime (s) of access tokens issued to MCP clients. |
| `EASYBILL_MCP_REFRESH_TOKEN_TTL` | `7776000` | Lifetime (s) of refresh tokens issued to MCP clients (90 days). |

Needs Node.js ≥ 22.13 (built-in `node:sqlite`). The `Dockerfile` builds a ready image:

```bash
docker build -t easybill-mcp .
docker run -p 3000:3000 -v easybill-mcp-data:/data \
  -v $PWD/tenants.json:/config/tenants.json:ro \
  -e EASYBILL_TENANTS_FILE=/config/tenants.json \
  -e EASYBILL_PUBLIC_URL=https://easybill-mcp.example.com \
  -e EASYBILL_MCP_SECRET="$(openssl rand -base64 48)" \
  easybill-mcp
```

**Cloudflare Zero Trust:** protect only the path `/connect` with an Access application (the
connect pages are opened in a browser). Leave `/mcp`, `/token`, `/register`, `/authorize` and
`/.well-known/*` outside Access — claude.ai calls them from its servers and cannot pass an Access
login. Without the connect pages nobody can complete the authorization, so tokens stay out of
reach. Set the two `EASYBILL_CF_ACCESS_*` variables so the server rejects requests that bypass
Cloudflare (e.g. via the origin IP).

Run it behind TLS (reverse proxy). Then in claude.ai: *Settings → Connectors → Add custom
connector* with `https://easybill-mcp.example.com/mcp` (organization admins can add it once for
everyone; each person still connects their own easybill logins).

### Security (hosted mode)

The server hands out access to easybill accounts with the rights of whoever connects them, so it
guards against the "confused deputy" attack from the MCP security best practices: someone registers
their own client with their own redirect URI, starts the authorization and sends a colleague the
resulting connect link. The colleague connects their easybill accounts, presses *Fertig* — and the
authorization code would go to the attacker. Two independent checks prevent that:

- **Redirect allowlist.** Dynamic client registration only accepts known redirect URIs
  (`invalid_redirect_uri` otherwise); `/authorize` checks again and answers with an error page
  instead of redirecting, so narrowing the list also locks out clients registered earlier.
  Loopback addresses are allowed because a code sent there can only reach the connecting person's
  own machine.
- **The connect page is the consent step.** At the top it names the app (its self-declared, unverified
  name) and, more importantly, the address the access goes to, with the advice to cancel if the
  person did not start the connection in Claude themselves. Every form on the page (connect, API key,
  disconnect, finish, cancel) carries a CSRF token that must match an `HttpOnly`, `SameSite=Strict`
  cookie scoped to that connect link, so another site cannot submit the forms in the person's
  browser even though the link itself may be known.

Other measures: easybill tokens and API keys are stored AES-GCM encrypted; the connect pages send a
strict CSP and cannot be framed; optionally they sit behind Cloudflare Access.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EASYBILL_API_KEY` | — | **Required.** Your easybill API key. |
| `EASYBILL_ENABLE_WRITES` | *unset* | Set to `true` to register create/update/delete tools. Otherwise read-only. |
| `EASYBILL_RATE_LIMIT_PER_MINUTE` | `60` | Client-side throttle. Use `10` for Professional, `60` for Premium. |
| `EASYBILL_CHARACTER_LIMIT` | `25000` | Max characters per response before truncation. |
| `EASYBILL_TIMEOUT_MS` | `30000` | HTTP request timeout. |
| `EASYBILL_MAX_RETRIES` | `3` | Retries on HTTP 429 / 5xx. |
| `EASYBILL_BASE_URL` | easybill production | Override for a proxy or test double. |

---

## Tools

### Customer lookup

| Tool | Access |
|---|---|
| `easybill_find_customer` | read — **start here**: search customers or suppliers by name, email or number |

Uses easybill's full-text search (one request, archived contacts included) and ranks the hits
locally, tolerating legal forms (`GmbH & Co. KG`), punctuation (`M.B. MUSTERMANN` vs
`MB Mustermann`), umlauts and word order. If the search endpoint is unavailable it falls back to
exact filters plus a local scan of the customer list.

### Documents — invoices, offers, credit notes, deliveries, orders

| Tool | Access |
|---|---|
| `easybill_list_documents` | read |
| `easybill_get_document` | read |
| `easybill_search_documents` | read — full-text search by word, name or number |
| `easybill_download_document` | read — PDF, image, ZUGFeRD 1.0–2.5, XRechnung (to disk locally, inline when hosted) |
| `easybill_list_document_versions` | read — audit trail |
| `easybill_create_document` | write |
| `easybill_update_document` | write |
| `easybill_complete_document` | write — finalises a draft, assigns the invoice number |
| `easybill_cancel_document` | write — creates a STORNO document |
| `easybill_convert_document` | write — OFFER → INVOICE, INVOICE → DUNNING, … |
| `easybill_send_document` | write — **sends real email / fax / post** |
| `easybill_delete_document` | write, destructive |

### Customers, contacts, groups

`easybill_list_customers`, `easybill_get_customer`, `easybill_create_customer`,
`easybill_update_customer`, `easybill_delete_customer`,
`easybill_list_contacts`, `easybill_get_contact`, `easybill_create_contact`,
`easybill_update_contact`, `easybill_delete_contact`,
`easybill_list_customer_groups`, `easybill_get_customer_group`

### Article catalogue and stock

`easybill_list_positions`, `easybill_get_position`, `easybill_create_position`,
`easybill_update_position`, `easybill_delete_position`,
`easybill_list_stock_entries`, `easybill_get_stock_entry`, `easybill_create_stock_entry`

### Payments

`easybill_list_document_payments`, `easybill_get_document_payment`,
`easybill_create_document_payment`, `easybill_delete_document_payment`

### Projects and time tracking

`easybill_list_projects`, `easybill_get_project`, `easybill_create_project`,
`easybill_update_project`, `easybill_delete_project`,
`easybill_list_time_trackings`, `easybill_get_time_tracking`,
`easybill_create_time_tracking`, `easybill_update_time_tracking`, `easybill_delete_time_tracking`

### Attachments and templates

`easybill_list_attachments`, `easybill_get_attachment`, `easybill_download_attachment`,
`easybill_delete_attachment`, `easybill_list_text_templates`, `easybill_get_text_template`,
`easybill_list_pdf_templates`

### Incoming documents (Eingangsbelege)

`easybill_list_incoming_documents`, `easybill_search_incoming_documents`,
`easybill_get_incoming_document`, `easybill_list_incoming_document_files`,
`easybill_download_incoming_document_file` (read);
`easybill_upload_incoming_document`, `easybill_update_incoming_document`,
`easybill_complete_incoming_document`, `easybill_delete_incoming_document` (write).

Uploads are extracted by easybill in the background; the tools guide the agent through
review → correction → completion.

### Server

`easybill_get_server_info` — reports mode, limits and whether the credentials work.
In hosted mode also `easybill_list_accounts` — connected accounts and the link to connect more.

Files in hosted mode: downloads come back inside the tool result and uploads take base64 —
the server never reads or writes caller-chosen paths on its own disk.

---

## Things worth knowing

### The server tells the agent how to sequence work

A plain set of endpoint wrappers leads agents astray. Handed an inbound customer inquiry,
Claude's first instinct was to call `easybill_list_documents` — which cannot answer the actual
first question, *is this company already a customer?*

The server therefore ships MCP **server instructions** (see `src/instructions.ts`) with the
ordering for common tasks, and `easybill_create_document` opens with the same sequence:

```
1. easybill_find_customer     — does the customer exist?
2. easybill_create_customer   — only if not
3. easybill_create_document   — creates a DRAFT
4. review with the user
5. easybill_complete_document — assigns the official number, locks it
6. easybill_send_document     — only when explicitly asked
```

`easybill_list_documents` explicitly says it is *not* the tool for orienting yourself. If you
extend this server, keep that pattern: state prerequisites at the top of the description of
the tool an agent will reach for first.

### All money is in cents

easybill represents every monetary value as an **integer in cents**, even where the API
types it as a float. `1999` means **19.99 EUR**. This is stated in every tool description
that touches an amount, because getting it wrong produces invoices off by 100×.

Times in time tracking (`timer_value`) are in **minutes**.

### Drafts vs. completed documents

`easybill_create_document` produces a **draft**. It has no official document number and can
still be edited. Call `easybill_complete_document` to finalise it — easybill then assigns the
number and locks it.

To void a completed invoice, use `easybill_cancel_document` (which creates a proper STORNO
document), not `easybill_delete_document`. Completed invoices generally cannot be deleted for
legal reasons.

### Rate limits are low

easybill allows **10 requests/minute on Professional** and **60 on Premium** (formerly PLUS and BUSINESS). The server throttles
itself to `EASYBILL_RATE_LIMIT_PER_MINUTE` and, if a 429 slips through, retries while honouring
`Retry-After`. Set the variable to match your plan — otherwise a broad question that pages
through many documents will stall.

Because of this, prefer narrow filters over paging: `easybill_list_documents` with
`type='INVOICE'` and `paid_at='null'` costs one request, where scanning everything costs dozens.

### Context management

`Document` has 69 fields and `Customer` 79. List tools therefore return a **compact default
field set**, and single-record lookups return everything. Both accept `fields`:

- omit it → compact defaults
- `fields: ["number", "amount"]` → just those (plus `id`)
- `fields: ["all"]` → every field

Responses over `EASYBILL_CHARACTER_LIMIT` are truncated, halving the item count until they
fit, and say so in `truncation_message`.

### Full-text search vs. filters

List filters match **exact** values (each accepts several comma-separated). For a partial name,
a word or a topic use the full-text tools (API 1.102+): `easybill_find_customer`,
`easybill_search_documents`, `easybill_search_incoming_documents`. Each costs one request.

### Useful filter recipes

| Question | Call |
|---|---|
| Which invoices are unpaid? | `easybill_list_documents` `type='INVOICE'`, `paid_at='null'` |
| Revenue in 2025? | `easybill_list_documents` `type='INVOICE'`, `document_date='2025-01-01,2025-12-31'` |
| One customer's history | `easybill_list_documents` `customer_id=<id>` |
| Only real, non-cancelled invoices | add `is_draft='0'`, `cancel_id='null'` |
| Unbilled tracked time | `easybill_list_time_trackings`, then filter `cleared_at = null` |

---

## Development

```bash
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm test           # offline suite — 37 tests, no credentials needed
npm run test:live  # read-only tests against a real account (needs .env)
npm run test:all   # both
npm run dev        # watch mode
npm run smoke      # read-only self-test against the live API (needs .env)
npm run inspect    # MCP Inspector against the built server (needs .env)
```

### Tests

`npm test` runs offline and needs no easybill account — it covers response shaping,
the HTTP client against a mock API, the rate-limit throttle, and the MCP surface
(schemas, annotations, write-gating, error handling) driven over the real stdio protocol.

```
test/
├── helpers/mcp-client.mjs  minimal MCP stdio client + mock API server
├── format.test.mjs         field selection, pagination, truncation, markdown
├── client.test.mjs         auth headers, query serialisation, 429 retry, error mapping
├── rate-limit.test.mjs     sliding-window throttle
├── server.test.mjs         tool registration, workflow guidance, validation, errors
└── live.test.mjs           optional: read-only checks against a real account
```

`live.test.mjs` skips itself unless `EASYBILL_API_KEY` is set, so contributors without an
account still get a green suite. It only reads — nothing in the test suite writes to easybill.

Project layout:

```
src/
├── index.ts              entry point, stdio transport, env validation, --selftest
├── instructions.ts       MCP server instructions: workflow ordering for the agent
├── constants.ts          config, summary field sets, enums
├── schemas/common.ts     shared Zod building blocks
├── services/
│   ├── client.ts         HTTP, auth, throttling, retries, error mapping
│   └── format.ts         field selection, pagination, markdown, truncation
└── tools/
    ├── registry.ts       registration + write-gating
    ├── crud.ts           generic CRUD tool factory
    ├── search.ts         fuzzy customer lookup
    ├── documents.ts      documents + lifecycle actions
    ├── customers.ts      customers, contacts, groups
    ├── catalog.ts        positions, stock
    ├── finance.ts        payments
    ├── work.ts           projects, time tracking
    ├── files.ts          attachments, templates
    └── meta.ts           server info
```

Most resources are generated from a declarative config in `crud.ts`; only genuinely
resource-specific behaviour (document lifecycle, downloads, sending) is hand-written.

## Contributing

Issues and pull requests welcome. The tool surface is derived from easybill's official
OpenAPI spec (`https://api.easybill.de/rest/v1/swagger.json`) — when adding a tool, check
field names and types against the spec rather than guessing, and mind that monetary fields
are cents even where the spec types them as floats.

## Disclaimer

This is an **unofficial**, community-maintained project. It is not affiliated with,
endorsed by, or supported by easybill GmbH. "easybill" is a trademark of its respective
owner and is used here only to describe what this software talks to.

The software is provided as-is under the MIT license, without warranty. It can create,
modify and delete records in your accounting system, and can send invoices to your
customers. You are responsible for what you let it do — start read-only, and review what
write tools produce before relying on it.

## License

[MIT](LICENSE) © stack74
