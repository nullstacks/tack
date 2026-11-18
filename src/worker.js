// Tack — paste a page, get a rendered link and a raw link.
//
// Storage: one Durable Object per page (SQLite-backed, strongly consistent), so a
// link works the instant it is copied — no KV propagation window.
// Frontend: static asset at public/index.html, served through the ASSETS binding.

import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

const MAX_BYTES = 1024 * 1024; // 1 MB per page
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";
const ID_LEN = 10;
const CACHE_OK = "public, max-age=300";

const enc = new TextEncoder();

/* ---------- helpers ---------- */

function rid(n = ID_LEN) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let out = "";
  for (let i = 0; i < n; i++) out += ID_ALPHABET[b[i] % ID_ALPHABET.length];
  return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

/* ---------- Durable Object: one page per instance ---------- */

export class DocStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = ctx.storage;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = "doc";

    if (url.pathname === "/put" && request.method === "POST") {
      const doc = await request.json();
      await this.store.put(key, doc);
      return json({ ok: true });
    }

    if (url.pathname === "/get") {
      const doc = await this.store.get(key);
      if (!doc) return json({ error: "Not found." }, 404);
      return json(doc);
    }

    if (url.pathname === "/delete" && request.method === "POST") {
      const { key: given } = await request.json().catch(() => ({}));
      const doc = await this.store.get(key);
      if (!doc) return json({ error: "Not found." }, 404);
      if (!given || (await sha256(given)) !== doc.key) return json({ error: "Wrong edit key." }, 403);
      await this.store.deleteAll();
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  }
}

/* ---------- rendered page shell for markdown / plain text ---------- */

const DOC_CSS = `body{margin:0;background:light-dark(#fff,#0f1117);color:light-dark(#16171d,#e8e9f0);font:17px/1.7 system-ui,-apple-system,sans-serif}article{max-width:72ch;margin:0 auto;padding:40px 22px 80px}h1,h2,h3{line-height:1.2;letter-spacing:-.02em}h1{font-size:2.1em}pre,code{font-family:ui-monospace,Menlo,monospace;font-size:.9em}pre{background:rgba(127,127,160,.14);padding:14px 16px;border-radius:6px;overflow:auto;white-space:pre-wrap}:not(pre)>code{background:rgba(127,127,160,.18);padding:.1em .35em;border-radius:3px}blockquote{margin:1em 0;padding:.2em 1em;background:rgba(127,127,160,.12);border-radius:6px}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid rgba(127,127,160,.4);padding:6px 10px}a{color:light-dark(#2230F0,#8b95ff)}`;

function renderDoc(doc) {
  const body = doc.type === "md" ? marked.parse(doc.content) : "<pre>" + esc(doc.content) + "</pre>";
  return `<!doctype html><meta charset="utf-8"><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(
    doc.name
  )}</title><style>${DOC_CSS}:root{color-scheme:light dark}</style><article>${body}</article>`;
}

function notFoundPage(id) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found · Tack</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#F2F3F8;color:#12131A;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#0B0C11;color:#ECEDF5}}
div{max-width:44ch}h1{font-size:1.9rem;letter-spacing:-.02em;margin:0 0 10px}p{color:#5A5E72;margin:0 0 22px}
@media (prefers-color-scheme:dark){p{color:#9A9FB6}}
a{display:inline-block;background:#2230F0;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:700}
code{font-family:ui-monospace,monospace;font-size:.9em}</style>
<div><h1>This tack isn’t here.</h1><p>It was deleted, or the id is wrong. Ids are 10 lowercase characters.</p><p style="font-size:13px">id: <code>${esc(
    id || ""
  )}</code></p><a href="/">Back to Tack</a></div>`;
}

/* ---------- data access ---------- */

const stubFor = (env, id) => env.DOCS.get(env.DOCS.idFromName(id));

async function getDoc(env, id) {
  const res = await stubFor(env, id).fetch("https://doc/get");
  if (!res.ok) return null;
  return await res.json();
}

/* ---------- routes ---------- */

async function handleDeploy(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const type = ["html", "md", "txt"].includes(body?.type) ? body.type : "txt";
  const content = typeof body?.content === "string" ? body.content : "";
  if (!content.trim()) return json({ error: "Nothing to deploy." }, 400);

  const size = enc.encode(content).length;
  if (size > MAX_BYTES) {
    return json({ error: "That page is over 1 MB. Trim it down first.", code: "too_large" }, 413);
  }

  if (env.DEPLOY_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.DEPLOY_LIMITER.limit({ key: ip });
    if (!success) {
      return json(
        { error: "You’re deploying fast. Give it a minute and try again.", code: "rate_limited" },
        429,
        { "retry-after": "60" }
      );
    }
  }

  const id = rid();
  const editKey = rid(20);
  const name = (typeof body?.name === "string" ? body.name.trim() : "").slice(0, 80) || "Untitled";
  const ts = Date.now();

  const put = await stubFor(env, id).fetch("https://doc/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name, type, size, ts, key: await sha256(editKey), content }),
  });
  if (!put.ok) return json({ error: "Could not save that page. Try again." }, 500);

  return json({ id, name, type, size, ts, editKey, preview: `/p/${id}`, raw: `/r/${id}` }, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS" && path.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,x-edit-key",
        },
      });
    }

    if (path === "/health") return json({ ok: true, service: "tack", ts: Date.now() });

    // POST /api/deploy
    if (path === "/api/deploy") {
      if (method !== "POST") return json({ error: "Method not allowed." }, 405);
      return handleDeploy(request, env);
    }

    // /api/doc/:id — GET meta+content, DELETE with x-edit-key
    const apiMatch = /^\/api\/doc\/([a-z0-9]{6,16})$/.exec(path);
    if (apiMatch) {
      const id = apiMatch[1];
      const doc = await getDoc(env, id);
      if (!doc) return json({ error: "Not found." }, 404);

      if (method === "GET") {
        const { key, ...rest } = doc;
        return json(rest);
      }
      if (method === "DELETE") {
        const given = request.headers.get("x-edit-key") || "";
        if (!given) return json({ error: "Wrong edit key." }, 403);
        const res = await stubFor(env, id).fetch("https://doc/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: given }),
        });
        return json(await res.json(), res.status);
      }
      return json({ error: "Method not allowed." }, 405);
    }

    // /p/:id rendered, /r/:id raw source
    const pageMatch = /^\/([pr])\/([a-z0-9]{6,16})\/?$/.exec(path);
    if (pageMatch) {
      const [, kind, id] = pageMatch;
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method not allowed.", { status: 405, headers: { allow: "GET, HEAD" } });
      }

      const doc = await getDoc(env, id);
      if (!doc) {
        return new Response(method === "HEAD" ? null : notFoundPage(id), {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (kind === "r") {
        return new Response(method === "HEAD" ? null : doc.content, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-length": String(doc.size),
            "cache-control": CACHE_OK,
            "x-content-type-options": "nosniff",
            "access-control-allow-origin": "*",
          },
        });
      }

      // Preview. HTML runs in a sandbox (opaque origin) so it cannot touch tack's
      // origin, cookies or storage; markdown/text is rendered server-side by marked
      // and further contained by a no-scripts sandbox.
      const isHtml = doc.type === "html";
      return new Response(method === "HEAD" ? null : isHtml ? doc.content : renderDoc(doc), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": CACHE_OK,
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": isHtml
            ? "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads"
            : "sandbox allow-popups",
        },
      });
    }

    // Static assets (index.html) for everything else; unknown paths get the 404 page.
    if (env.ASSETS && (method === "GET" || method === "HEAD")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
    }
    return new Response(method === "HEAD" ? null : notFoundPage(""), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  },
};
