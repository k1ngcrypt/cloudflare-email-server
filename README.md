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
6. Optional: set `APP_ORIGIN` in Wrangler vars if the UI is served from a different trusted origin.
7. Configure `.dev.vars` for local development (see `.dev.vars.example`).

## Security Notes

- Passwords are stored using `argon2id` hashes (legacy SHA-256 hashes are upgraded automatically on successful login).
- API sessions are set as `HttpOnly` secure cookies and can also be used as bearer tokens for non-browser clients.
- Login attempts are throttled per `client-ip + username` key (`login_attempts` table in `schema.sql`).
- If this project was already deployed before this update, re-run `npm run db:migrate` to create the new table/indexes.

## Commands

- `npm run dev`
- `npm run typecheck`
- `npm run deploy`
- `npm run db:create`
- `npm run db:migrate`
