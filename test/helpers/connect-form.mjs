/**
 * Submits the connect page's forms the way a browser does: every POST under
 * /connect/<sid>/… needs this browser's nonce cookie (set by the connect page)
 * and the matching token from the form's hidden "csrf" field.
 */

/** Cookie names of the browser nonce: __Host- prefixed over https, plain over http. */
export const BROWSER_COOKIE = /^(?:__Host-)?easybill_mcp_browser$/;

/** A minimal cookie jar: one per simulated browser. */
export class Browser {
  constructor(base, cookies = {}) {
    this.base = base;
    this.jar = new Map(Object.entries(cookies));
  }

  /** Adds or replaces a cookie, e.g. from a "name=value" string. */
  set(pair) {
    const [name, ...rest] = pair.split(";")[0].trim().split("=");
    this.jar.set(name, rest.join("="));
  }

  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** The browser nonce cookie as "name=value", if this browser has one. */
  get browserCookie() {
    const entry = [...this.jar].find(([k]) => BROWSER_COOKIE.test(k));
    return entry ? `${entry[0]}=${entry[1]}` : undefined;
  }

  /** fetch without following redirects; sends and stores cookies. */
  async fetch(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (this.jar.size > 0) headers.Cookie = this.cookieHeader;
    const res = await fetch(new URL(path, this.base), { redirect: "manual", ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(line)) this.jar.delete(line.split("=")[0]);
      else this.set(line);
    }
    return res;
  }

  /** Opens the connect page of the session in `connectPath` and returns its form token. */
  async csrf(connectPath) {
    const sid = /^\/connect\/([^/?]+)/.exec(new URL(connectPath, this.base).pathname)?.[1];
    if (!sid) throw new Error(`not a connect path: ${connectPath}`);
    const page = await this.fetch(`/connect/${sid}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
    if (!this.browserCookie || !csrf) throw new Error(`connect page ${connectPath} set no browser cookie or token (HTTP ${page.status})`);
    return csrf;
  }

  /** POSTs a form with this browser's cookies and the given (or a freshly fetched) token. */
  async post(path, fields = {}, csrf) {
    const token = csrf === undefined ? await this.csrf(path) : csrf;
    return this.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...fields, ...(token === null ? {} : { csrf: token }) }),
    });
  }
}

/** Opens the connect page in a fresh browser; returns its nonce cookie ("name=value") and form token. */
export async function csrfFor(base, connectPath) {
  const browser = new Browser(base);
  const csrf = await browser.csrf(connectPath);
  return { cookie: browser.browserCookie, csrf };
}

/** POSTs a connect-page form from a fresh browser (cookie and field set), without following redirects. */
export async function submitForm(base, path, fields = {}) {
  return new Browser(base).post(path, fields);
}
