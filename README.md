# Tack

Paste a page. Get a rendered link and a raw link.

Tack is a tiny pastebin-for-pages. Drop in HTML, Markdown or plain text, and it gives you two
URLs: `/p/<id>` renders the page, `/r/<id>` returns the source verbatim. No account, no
dashboard, no build step — one Cloudflare Worker, a Durable Object per page, and a single static
HTML file.

**Live:** https://tack.nullstacks.workers.dev

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nullstacks/tack)

---

## What it does

| Route | What you get |
|---|---|
| `GET /` | The editor UI |
| `POST /api/deploy` | Stores a page, returns `{id, editKey, preview, raw}` |
| `GET /p/:id` | The rendered page (Markdown/plain text wrapped in a clean reading shell) |
| `GET /r/:id` | The raw source as `text/plain` |
| `GET /api/doc/:id` | JSON metadata + content |
| `DELETE /api/doc/:id` | Deletes the page — requires the `x-edit-key` header |
| `GET /health` | `{"ok":true}` |

- **1 MB** per page, **30 deploys / minute** per IP (Cloudflare's native rate-limit binding).
- Ids are 10 chars from a 31-char alphabet (~8×10¹⁴ combinations), unguessable and unlisted.
- Every deploy returns an **edit key**, held only by the browser that made it. Nothing else can
  delete the page — not even a valid id.
- "Your deploys" lives in `localStorage`; it is a convenience list, not an account.

## Storage: why Durable Objects

Each page lives in **its own Durable Object** (`DocStore`), keyed by the page id. One page per
object means:

- **Strong consistency.** A link works the instant it is returned. KV is eventually consistent —
  a fresh copy can 404 for up to ~60s after the write, which is fatal when the whole product is
  "here is your link".
- **Isolation.** Write/delete for one page cannot contend with any other page.
- **No index to maintain.** Lookup is `idFromName(id)` → object → read.

Storage is the Durable Object SQLite backend, and it sits inside Cloudflare's free plan
(100k requests/day, 5 GB).

## Deploy it yourself

```bash
git clone https://github.com/nullstacks/tack
cd tack
npm install

npx wrangler login          # OAuth, opens a browser
npx wrangler deploy         # prints https://tack.<your-subdomain>.workers.dev
```

That's it — `wrangler.toml` needs no edits. There is no database to create, no schema to apply,
and no secrets to set: the Durable Object namespace is declared in the config and created on
first deploy.

Local development:

```bash
npx wrangler dev            # http://localhost:8787, fully local (Miniflare)
```

### Config knobs

`wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "DEPLOY_LIMITER"
type = "ratelimit"
namespace_id = "2001"          # any integer, unique per account+namespace
simple = { limit = 30, period = 60 }
```

Change the limit to taste, or delete the block to remove throttling (the Worker checks for the
binding and skips the limit if it is absent).

Limits are also enforced in code: `MAX_BYTES` in `src/worker.js` (1 MB) and the name length
(80 chars).

## Security model

Deployed HTML is user content, so it is contained rather than trusted:

- `/p/:id` for HTML pages is served with
  `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads`.
  The browser puts the document in an **opaque origin**: its scripts run, but `localStorage`,
  cookies and same-origin `fetch` against tack are all blocked (`SecurityError`), so a pasted page
  cannot read other pages or poison the editor.
- `/r/:id` always returns `text/plain` with `X-Content-Type-Options: nosniff`, so raw source can
  never execute on tack's origin.
- Markdown is rendered **server-side** by `marked`, not by a client-side lib, so the shared link
  works with no JS at all.
- `rel="noopener"`, `referrer-policy: no-referrer`, and HTML pages do not inherit the app's
  origin — links open on the page's own host.
- Edit keys are stored as SHA-256 hashes; the plaintext key never leaves the deploying browser
  after it is issued.

There is no content moderation. Anything public and anonymous on the internet gets abused; if you
run a fork for a large audience, put a WAF or Workers Rate Limiting in front of `/api/deploy` and
sweep old rows on a cron.

## Layout

```
src/worker.js      Worker + DocStore Durable Object (routing, rendering, storage)
public/index.html  The whole editor UI — one file, no build step, no framework
wrangler.toml      Bindings: ASSETS, DOCS (DO), DEPLOY_LIMITER
```

The frontend has no bundler on purpose. `marked` in the Worker handles Markdown; the editor's
live preview uses the CDN build of `marked` + `DOMPurify` purely so you can see the render before
you deploy. The stored copy is always rendered server-side.

## Design notes

Two links, always visible, never confused: `/p/` is the thing you show someone, `/r/` is the thing
you hand to a machine. The editor is a sheet of paper with crop marks; the result is a receipt.
Same aesthetic as the rest of nullstacks.

## License

MIT — see [LICENSE](LICENSE).
