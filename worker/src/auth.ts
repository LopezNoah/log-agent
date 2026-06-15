import type { Hono, Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "./env";
import { safeEqual, signSession, verifySession } from "./crypto";

const COOKIE = "ocp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Reachable without a session: the login page itself, logout, and the static assets the
// login page needs to render. Everything else is gated.
const PUBLIC_PREFIXES = ["/login", "/logout", "/styles.css", "/vendor/", "/favicon"];

function isPublic(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));
}

// Gate every route behind a valid signed cookie. Browser navigations get a 302 to the styled
// login page; API/WebSocket calls get a 401 (the SPA turns that into its own redirect).
export const requireSession = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const path = new URL(c.req.url).pathname;
  if (isPublic(path)) return next();
  if (await verifySession(c.env, getCookie(c, COOKIE))) return next();

  const accept = c.req.header("Accept") || "";
  if (c.req.method === "GET" && accept.includes("text/html")) return c.redirect("/login");
  return c.json({ error: "unauthorized" }, 401);
};

function setSessionCookie(c: Context<{ Bindings: Env }>, token: string): void {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function registerAuthRoutes(app: Hono<{ Bindings: Env }>): void {
  // Already signed in → skip the login page. Otherwise serve the static login page. The asset
  // server maps login.html to the extensionless "/login", so fetch that (fetching "/login.html"
  // would 307-redirect back to "/login" and loop).
  app.get("/login", async (c) => {
    if (await verifySession(c.env, getCookie(c, COOKIE))) return c.redirect("/");
    return c.env.ASSETS.fetch(new Request(new URL("/login", c.req.url), { headers: c.req.raw.headers }));
  });

  app.post("/login", async (c) => {
    const { password } = (await c.req.json().catch(() => ({}))) as { password?: string };
    if (!c.env.CONTROL_PASSWORD || !password || !safeEqual(password, c.env.CONTROL_PASSWORD)) {
      return c.json({ error: "invalid_password" }, 401);
    }
    setSessionCookie(c, await signSession(c.env, SESSION_TTL_MS));
    return c.json({ ok: true });
  });

  const logout = (c: Context<{ Bindings: Env }>) => {
    setCookie(c, COOKIE, "", { path: "/", maxAge: 0 });
    return c.redirect("/login");
  };
  app.get("/logout", logout);
  app.post("/logout", logout);
}
