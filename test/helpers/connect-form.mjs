/**
 * Submits the connect page's forms the way a browser does: every POST under
 * /connect/<sid>/… needs the CSRF cookie the page sets and the same token in the
 * form's hidden "csrf" field.
 */

/** Opens the connect page of the session in `connectPath` and returns its CSRF cookie and form token. */
export async function csrfFor(base, connectPath) {
  const sid = /^\/connect\/([^/?]+)/.exec(new URL(connectPath, base).pathname)?.[1];
  if (!sid) throw new Error(`not a connect path: ${connectPath}`);
  const page = await fetch(new URL(`/connect/${sid}`, base), { redirect: "manual" });
  const html = await page.text();
  const cookie = /easybill_mcp_csrf=[^;]+/.exec(page.headers.get("set-cookie") ?? "")?.[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!cookie || !csrf) throw new Error(`connect page ${connectPath} set no CSRF cookie or token (HTTP ${page.status})`);
  return { cookie, csrf };
}

/** POSTs a connect-page form with the CSRF cookie and field, without following redirects. */
export async function submitForm(base, path, fields = {}) {
  const { cookie, csrf } = await csrfFor(base, path);
  return fetch(new URL(path, base), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ ...fields, csrf }),
  });
}
