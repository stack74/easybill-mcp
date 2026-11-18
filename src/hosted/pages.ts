/**
 * HTML for the connect page — the page a person lands on when they connect the
 * MCP server in claude.ai. Server-rendered, no JavaScript, German UI.
 */

import type { TenantConfig } from "./config.js";
import type { ConnectionRow, SessionRow } from "./store.js";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5f6b7a; --line:#e3e7ed; --accent:#1f6feb; --ok:#1a7f37; --warn:#b35900; --danger:#c62828; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --text:#e6e9ee; --muted:#9aa5b4; --line:#2a313b; --accent:#4c8dff; --ok:#3fb950; --warn:#e3913a; --danger:#f0605d; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
main { max-width:640px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 6px; }
p.lead { color:var(--muted); margin:0 0 24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; }
.tenant { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:14px 16px; flex-wrap:wrap; }
.tenant + .tenant { border-top:1px solid var(--line); }
.name { font-weight:600; }
.status { font-size:13px; color:var(--muted); }
.status.ok { color:var(--ok); } .status.warn { color:var(--warn); }
.badge { font-size:12px; border:1px solid var(--line); border-radius:99px; padding:1px 8px; margin-left:6px; color:var(--muted); font-weight:400; }
.actions { display:flex; gap:8px; }
form { margin:0; }
button { font:inherit; font-size:14px; border-radius:7px; padding:6px 14px; cursor:pointer; border:1px solid var(--line); background:var(--card); color:var(--text); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.link { border:none; background:none; color:var(--danger); padding:6px 4px; }
button:disabled { opacity:.45; cursor:not-allowed; }
.footer { display:flex; gap:12px; justify-content:flex-end; align-items:center; margin-top:20px; flex-wrap:wrap; }
.footer .hint { margin-right:auto; color:var(--muted); font-size:13px; }
.banner { border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:14px; border:1px solid; }
.banner.error { border-color:var(--danger); color:var(--danger); }
.banner.notice { border-color:var(--ok); color:var(--ok); }
details { margin-top:24px; color:var(--muted); font-size:13px; }
.hint { color:var(--muted); font-size:13px; }
.consent { padding:14px 16px; margin:16px 0 20px; border-color:var(--accent); }
.consent p { margin:0 0 8px; } .consent p:last-child { margin-bottom:0; }
`;

let iconLink = "";

/** Links the configured icon from every page (set once at startup). */
export function setPageIcon(href: string, mimeType: string): void {
  iconLink = `<link rel="icon" href="${escape(href)}" type="${escape(mimeType)}">`;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title>${iconLink}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const formatDate = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });

export type ConnectMode = "apikey" | "oauth";

/** Hidden form field carrying the CSRF token (checked against a SameSite=Strict cookie). */
const csrfField = (token: string): string => `<input type="hidden" name="csrf" value="${escape(token)}">`;

/** Who receives the access, in words a person can check. */
function describeTarget(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return `eine App auf <b>deinem eigenen Computer</b> (${escape(url.host)}), z.&nbsp;B. Claude Code oder Claude Desktop`;
    }
    return `<b>${escape(url.host)}</b> <span class="hint">${escape(url.pathname)}</span>`;
  } catch {
    return escape(redirectUri);
  }
}

/** The consent part of the connect page: which app asks and where the access goes. */
function consentBox(client: { name?: string | undefined; redirectUri: string }): string {
  const name = client.name?.trim() ? `„${escape(client.name.trim().slice(0, 100))}“` : "Eine App ohne Namen";
  return `<div class="card consent">
      <p><b>${name}</b> möchte Zugriff auf die easybill-Accounts, die du hier verbindest – mit deinen Rechten.</p>
      <p>Mit „Fertig“ geht der Zugriff an:<br>${describeTarget(client.redirectUri)}</p>
      <p class="hint">Den Namen gibt die App selbst an, er ist nicht geprüft – entscheidend ist die Adresse.
      Hast du diese Verbindung nicht selbst in Claude gestartet, klicke auf „Abbrechen“ und verbinde nichts.</p>
    </div>`;
}

function tenantRow(
  sessionId: string,
  tenant: TenantConfig,
  connection: ConnectionRow | undefined,
  mode: ConnectMode,
  csrf: string,
): string {
  const base = `/connect/${encodeURIComponent(sessionId)}/tenants/${encodeURIComponent(tenant.id)}`;
  const badge = `<span class="badge">${tenant.writes ? "Lesen &amp; Schreiben" : "Nur lesen"}</span>`;
  // API-key mode opens a form (GET); OAuth mode starts the easybill login (POST).
  const connectButton = (label: string, primary: boolean): string =>
    mode === "apikey"
      ? `<form method="get" action="${base}/key"><button${primary ? ' class="primary"' : ""}>${label}</button></form>`
      : `<form method="post" action="${base}/connect">${csrfField(csrf)}<button${primary ? ' class="primary"' : ""}>${label}</button></form>`;
  const disconnect = `<form method="post" action="${base}/disconnect">${csrfField(csrf)}<button class="link">Trennen</button></form>`;
  let status: string;
  let actions: string;
  if (!connection) {
    status = `<div class="status">Nicht verbunden</div>`;
    actions = connectButton("Verbinden", true);
  } else if (connection.broken_reason) {
    status = `<div class="status warn">${
      connection.auth_kind === "apikey" ? "API-Key ungültig – bitte neu hinterlegen" : "Verbindung abgelaufen – bitte neu verbinden"
    }</div>`;
    actions = connectButton("Neu verbinden", true) + disconnect;
  } else {
    const who = connection.login_label
      ? connection.auth_kind === "apikey"
        ? ` (${escape(connection.login_label)})`
        : ` als ${escape(connection.login_label)}`
      : "";
    status = `<div class="status ok">✓ Verbunden${who} · seit ${formatDate(connection.connected_at)}</div>`;
    actions = connectButton("Neu verbinden", false) + disconnect;
  }
  return `<div class="tenant"><div><div class="name">${escape(tenant.name)}${badge}</div>${status}</div><div class="actions">${actions}</div></div>`;
}

export interface ConnectPageInput {
  mode: ConnectMode;
  /** Who is looking, when Cloudflare Access is in front (their e-mail). */
  viewer?: string;
  session: SessionRow;
  /** CSRF token for the forms; the same value is set as a SameSite=Strict cookie. */
  csrfToken: string;
  /** The MCP client asking for access (authorize sessions only). */
  client?: { name?: string | undefined; redirectUri: string };
  tenants: TenantConfig[];
  connections: ConnectionRow[];
  error?: string;
  notice?: string;
}

export function renderConnectPage({
  mode,
  viewer,
  session,
  csrfToken,
  client,
  tenants,
  connections,
  error,
  notice,
}: ConnectPageInput): string {
  const byTenant = new Map(connections.map((c) => [c.tenant_id, c]));
  const usable = connections.filter((c) => !c.broken_reason && tenants.some((t) => t.id === c.tenant_id)).length;
  const sid = encodeURIComponent(session.id);

  const banners =
    (error ? `<div class="banner error">${escape(error)}</div>` : "") +
    (notice ? `<div class="banner notice">${escape(notice)}</div>` : "");

  const footer =
    session.kind === "authorize"
      ? `<div class="footer">
          <span class="hint">${usable === 0 ? "Verbinde mindestens einen Account." : `${usable} Account${usable === 1 ? "" : "s"} verbunden.`}</span>
          <form method="post" action="/connect/${sid}/cancel">${csrfField(csrfToken)}<button>Abbrechen</button></form>
          <form method="post" action="/connect/${sid}/finish">${csrfField(csrfToken)}<button class="primary"${usable === 0 ? " disabled" : ""}>Fertig – zurück zu Claude</button></form>
        </div>`
      : `<div class="footer"><form method="post" action="/connect/${sid}/finish">${csrfField(csrfToken)}<button class="primary">Fertig</button></form></div>`;

  return layout(
    "easybill verbinden",
    `<h1>easybill-Accounts verbinden</h1>
    ${session.kind === "authorize" && client ? consentBox(client) : ""}
    <p class="lead">Verbinde jeden Account, auf den du Zugriff hast, ${
      mode === "apikey" ? "mit deinem persönlichen easybill-API-Key" : "mit deinem eigenen easybill-Login"
    }.
    Accounts ohne Zugriff lässt du einfach aus – du kannst sie später ergänzen.</p>
    ${viewer ? `<p class="status" style="margin:-16px 0 20px">Angemeldet als ${escape(viewer)}</p>` : ""}
    ${banners}
    <div class="card">${tenants.map((t) => tenantRow(session.id, t, byTenant.get(t.id), mode, csrfToken)).join("")}</div>
    ${footer}
    <details><summary>Hinweise</summary>${
      mode === "apikey"
        ? `<p>Dein API-Key wird verschlüsselt gespeichert und nur für deine eigenen Anfragen über Claude verwendet.</p>
      <p>Den Zugriff entziehst du hier über „Trennen“ – oder in easybill, indem du einen neuen API-Key generierst; der alte ist dann ungültig.</p>`
        : `<p>„Verbinden“ öffnet die Anmeldung von easybill. Deine Zugangsdaten gibst du nur dort ein; dieser Server sieht sie nie und speichert nur das Zugriffstoken, das easybill ausstellt.</p>
      <p>Meldet easybill dich automatisch mit dem falschen Account an, melde dich in easybill ab und verbinde erneut.</p>
      <p>Den Zugriff kannst du jederzeit hier über „Trennen“ oder in easybill selbst entziehen.</p>`
    }
    </details>`,
  );
}

export function renderKeyForm(session: SessionRow, tenant: TenantConfig, csrfToken: string, error?: string): string {
  const sid = encodeURIComponent(session.id);
  const action = `/connect/${sid}/tenants/${encodeURIComponent(tenant.id)}/key`;
  return layout(
    `${tenant.name} verbinden`,
    `<h1>„${escape(tenant.name)}“ verbinden</h1>
    <p class="lead">Füge deinen persönlichen API-Key aus diesem easybill-Account ein.</p>
    ${error ? `<div class="banner error">${escape(error)}</div>` : ""}
    <div class="card" style="padding:16px">
      <ol style="margin:0 0 16px; padding-left:20px">
        <li>In easybill bei „${escape(tenant.name)}“ einloggen.</li>
        <li>Rechts oben aufs Benutzer-Icon → <b>Profil und Einstellungen</b>.</li>
        <li>Im Abschnitt <b>API Key</b> den Schlüssel über das Augensymbol anzeigen und kopieren.
          Gibt es noch keinen: <b>Neuen Schlüssel generieren</b> und rechts oben <b>Speichern</b>.</li>
      </ol>
      <form method="post" action="${action}">
        ${csrfField(csrfToken)}
        <label for="api_key" style="display:block; font-weight:600; margin-bottom:6px">API-Key</label>
        <input id="api_key" name="api_key" type="password" required autocomplete="off" spellcheck="false"
          style="width:100%; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--text)">
        <div class="footer">
          <span class="hint">Ein neu generierter Key ersetzt den alten – Integrationen, die den alten nutzen, hören dann auf zu funktionieren.</span>
          <a href="/connect/${sid}" style="color:var(--muted)">Zurück</a>
          <button class="primary">Prüfen und verbinden</button>
        </div>
      </form>
    </div>`,
  );
}

export function renderMessage(title: string, text: string): string {
  return layout(title, `<h1>${escape(title)}</h1><p class="lead">${escape(text)}</p>`);
}
