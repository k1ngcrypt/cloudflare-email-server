# cloudflare-webmail

Cloudflare Worker webmail server:
- inbound email via Email Worker -> D1
- attachments persisted in R2 and linked in D1
- HTTP API + single-file webmail UI
- outbound SMTP via OCI using worker-mailer

## Setup

1. Install dependencies.
2. Create D1 DB and update `wrangler.toml` with your `database_id`.
3. Create an R2 bucket for attachments and keep the bucket name aligned with `wrangler.toml` (`webmail-attachments` by default).
4. Apply `schema.sql`.
5. Set secrets with Wrangler:
   - `OCI_SMTP_USER`
   - `OCI_SMTP_PASS`
   - `AUTH_SECRET`
6. Configure `.dev.vars` for local development (see `.dev.vars.example`).

## Commands

- `npm run dev`
- `npm run typecheck`
- `npm run deploy`
- `npm run db:create`
- `npm run db:migrate`
