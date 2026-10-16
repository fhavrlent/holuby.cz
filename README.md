# holuby.cz — Holubí náměstí

A shared virtual town square full of pigeons. Click to scatter sunflower seeds, swipe fast to scare the flock.
Everyone on the page is on the same square: seeds thrown by other visitors arrive in real time
(marked with an orange ring), and an all-time handful counter is kept server-side.

## How it works

- `src/index.ts` — a Cloudflare Worker that serves the page and routes `/ws` to a single
  Durable Object (`Namesti`). The DO uses the WebSocket Hibernation API, rate-limits each socket
  with a token bucket, broadcasts crumbs, tracks who's present, and batches counter writes to
  SQLite storage via an alarm.
- `src/page.html` — the whole front end: a canvas scene with procedurally drawn cobblestones,
  autumn leaves, pigeons (head-bobbing walk, pecking, cooing, take-off/landing, feathers) and
  optional synthesized sound (Web Audio, off by default). The pigeon simulation is local to each
  browser; only crumbs and presence are shared.

## Develop

```bash
npm install
npm run dev
```

## Deploy

```bash
npx wrangler deploy
```

Custom domains `holuby.cz` and `www.holuby.cz` are attached by `wrangler.jsonc`; `www` redirects to the apex.
