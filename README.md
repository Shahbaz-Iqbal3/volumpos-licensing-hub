# VolumPOS Licensing Hub

Developer-owned licensing hub for the VolumPOS product family. It is a **separate
Supabase project** from any customer's data-sync cloud, and is exposed only
through Edge Functions.

- Issues purchase keys and signs licenses (Ed25519, using `@volumpos/license`).
- Activates machines over one internet round trip, then goes quiet.
- Renews subscription licenses silently via `/renew` (no repeat key entry).
- Logs every attempt to `checkin_log` for abuse detection.

See [`../volumpos-license/docs/ECOSYSTEM.md`](../volumpos-license/docs/ECOSYSTEM.md)
for the full family setup.

---

## Layout

```
volumpos-licensing-hub/
├── admin.html / admin.js                 # minimal internal admin panel
├── supabase/
│   ├── migrations/0001_licensing_hub.sql # schema + RLS lockdown
│   └── functions/
│       ├── _shared/                      # runtime-neutral helpers
│       │   ├── encoding.ts               # WebCrypto-safe base64/hash
│       │   ├── licenseSign.ts            # WebCrypto Ed25519 wire signer
│       │   ├── logic.ts                  # activation/renewal decisions (pure)
│       │   ├── keys.ts                   # purchase key gen/hash
│       │   ├── db.ts                     # service client + check-in log
│       │   ├── constants.ts
│       │   └── http.ts
│       ├── activate/index.ts             # POST /activate
│       ├── renew/index.ts                # POST /renew
│       ├── verify/index.ts               # POST /verify (admin secret)
│       └── admin/index.ts                # POST /admin (admin secret)
├── scripts/verify-keypair.ts             # confirm hub key == product key
└── test/crossCompat.test.ts              # hub signer vs @volumpos/license
```

## Why the signer is reimplemented

Edge Functions run on Deno and cannot import the Node build of
`@volumpos/license`, so `_shared/licenseSign.ts` is a WebCrypto implementation
of the same wire format. The two are kept honest by tests:

- `crossCompat.test.ts` signs with the hub and **verifies with the package**.
- It also asserts the hub and package serialize the same payload to the
  **byte-identical** JSON, which is what makes signatures interchangeable.

Run them with `npm test`.

## Endpoints

| Function | Auth | Purpose |
|---|---|---|
| `POST /activate` | purchase key | First activation; returns a signed license. Re-issue on same machine. |
| `POST /renew` | license id + fingerprint | Silent subscription check-in; returns a fresh signed license. |
| `POST /verify` | `x-admin-secret` | Support lookup by key / license id / customer id. |
| `POST /admin` | `x-admin-secret` | Issue customers/licenses/subscriptions; stats. |

`verify` and `admin` are gated by `LICENSE_ADMIN_SECRET` so they cannot be used
to enumerate customers from the internet.

## Security model

- RLS is enabled on all tables with **no policies**: anon/authenticated roles
  get nothing. Only `service_role` (used inside the Functions) can read/write.
- The **purchase key is never stored**. We store `key_hash` (SHA-256) and
  `key_last4`. The raw key is returned exactly once, at issuance.
- The **private signing key lives only** in the `LICENSE_PRIVATE_KEY` secret.
- The hub is fully decoupled from customer data-sync projects.

## Setup

### 1. Local checks (no Supabase needed)

```bash
cd volumpos-licensing-hub
npm install
npm test
npm run typecheck
```

### 2. Create the Supabase project

```bash
npm i -g supabase
supabase login
supabase link --project-ref <your-new-project-ref>
supabase db push                      # applies supabase/migrations
```

### 3. Set secrets

```bash
supabase secrets set \
  LICENSE_PRIVATE_KEY="$(node -e "console.log(require('./license-keys.json').privateKey)")" \
  LICENSE_ADMIN_SECRET="<a long random string>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically by the
Supabase runtime; do not set them manually.

Confirm the key matches the products **before** going live:

```bash
LICENSE_PRIVATE_KEY=... npm run verify-keypair
```

### 4. Deploy the functions

```bash
supabase functions deploy activate renew verify admin --no-verify-jwt
```

`--no-verify-jwt` is required: products call these without a Supabase user
session. Safety comes from the purchase key / admin secret, not JWT.

### 5. Configure and open the admin panel

The panel is static. Its base URL comes from `.env`, via a generated
`config.js` (a browser cannot read `.env` directly):

```bash
cp .env.example .env      # then set HUB_URL
npm run config            # writes config.js from .env (gitignored)
```

Then serve the folder and open `admin.html`:

```bash
npx serve .
```

The **Hub base URL** field is pre-filled from `config.js` and stays editable so
a staging hub can be targeted without a rebuild. The **Admin secret** is always
typed by the operator and kept in `sessionStorage` — it is never written to
`config.js` or any other served file.

Then create a customer, issue a license, and copy the one-time key.

> ⚠️ **Never put the admin secret in `.env` or `config.js`.** Everything the
> panel serves is public. `.env` holds the URL only.

---

## Deploying the admin panel online

The hub endpoint is already reachable from the internet (that is what lets
products activate). Hosting the panel publicly therefore does not expose a new
secret — the page contains none — but it does add **discoverability**, so the
hardening below matters.

### Current protections

- `/admin` and `/verify` require the `x-admin-secret` header, compared in
  constant time.
- Repeated failures from one IP are throttled (20 per 15 min, then HTTP 429).
  Throttling applies **after** the secret check, so a valid operator is never
  locked out by someone else's attempts on the same IP.
- Every attempt is recorded in `checkin_log` (`action = 'admin-auth'`).

### Recommended: put an auth gate in front

Do not rely on the shared secret alone for a public URL. Front the static panel
with an identity layer:

- **Cloudflare Access** (or a Cloudflare Tunnel with Zero Trust) — no code
  changes, add an email/SSO policy.
- **Vercel Password Protection / Deployment Protection** — one toggle for a
  Vercel-hosted panel.
- **Netlify password protection** for Netlify-hosted panels.

Then narrow CORS so only that origin may call the hub:

```bash
supabase secrets set ADMIN_ALLOWED_ORIGIN="https://admin.example.com"
```

`ADMIN_ALLOWED_ORIGIN` accepts a comma-separated list. When unset, CORS stays
open (`*`), which is fine for local development. CORS is a browser-side control
only — it does not stop scripts — so it complements, never replaces, the secret
and the auth gate.

### Checklist before going public

- [ ] Rotate `LICENSE_ADMIN_SECRET` (assume any value ever pasted into a chat,
      ticket, or commit is burned).
- [ ] Set `ADMIN_ALLOWED_ORIGIN` to the panel's exact origin.
- [ ] Put Cloudflare Access / Vercel / Netlify protection in front.
- [ ] Confirm `.env` and `config.js` are gitignored and contain no secret.
- [ ] Verify a correct secret works and a wrong one returns 403.

## Product-side contract

`/activate` request:

```json
{
  "license_key": "POS-REST-KX7P-92MD",
  "machine_fingerprint": "<composite hash>",
  "sources": { "machine-guid": "…", "cpu": "…", "disk": "…" },
  "product": "RESTAURANT_POS",
  "shop_name": "My Restaurant"
}
```

`/renew` request:

```json
{
  "license_id": "LIC-0000001",
  "machine_fingerprint": "<composite hash>",
  "sources": { "…": "…" },
  "shop_name": "My Restaurant"
}
```

Both return `{ ok: true, license: "<signed key>" , … }`. `/renew` may return
`{ ok: false, billing: true, error }` when the subscription is not active, which
the client should surface as a billing banner rather than a license error.

## Test coverage (19 tests)

- Hub-signed license verifies in `@volumpos/license` (fuzzy fingerprint and
  product check).
- Byte-identical payload serialization between hub and package.
- Public-key derivation matches the package keypair.
- Activation: same-machine reissue, fuzzy reissue, seat grant, over-limit deny,
  deactivated seats ignored.
- Entitlement: revoked/suspended denied; subscription cancelled/past_due/paused
  denied; active within buffer allowed; perpetual-no-expiry allowed.
- Purchase keys: format, no ambiguous characters, normalization, hashing,
  uniqueness.
