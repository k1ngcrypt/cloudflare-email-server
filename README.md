# cloudflare-webmail

Cloudflare Worker webmail server unifying all documentation.

## Architecture Overview

**Internet** ──► **Cloudflare Email Routing**
                   │
                   ▼
         [Email Worker: email() handler]
                   │  postal-mime parses raw MIME
                   ▼
            [D1 Database + R2 Bucket]
           emails / attachments / users / sessions
                   │
                   ▼
         [Worker: fetch() HTTP handler]
         REST API + serves static SPA + attachments
                   │
                   ▼
           [Webmail SPA]
          (vanilla JS, single HTML file
           bundled and served by the Worker)

Outbound:
 [Webmail compose → POST /api/send]
       │
       ▼
 [Worker fetch() handler]
       │  Signed OCI HTTPS request
       │  POST /20220926/actions/submitRawEmail over TLS
       ▼
 [OCI Email Delivery Submission endpoint]
       │
       ▼
  Recipient inbox

Everything lives in **one Cloudflare Worker** with two exported handlers:
- `email(message, env, ctx)` — triggered by incoming mail
- `fetch(request, env, ctx)` — serves the REST API, attachments, and the webmail HTML

## Setup

1. Install dependencies: `npm install`
2. Create D1 DB and update `wrangler.toml` with your `database_id`.
3. Create an R2 bucket for attachments and keep the bucket name aligned with `wrangler.toml` (`webmail-attachments` by default).
4. Apply `schema.sql`: `npm run db:migrate` or `wrangler d1 execute webmail-db --file=./schema.sql`
5. Set secrets with Wrangler:
      - `OCI_EMAIL_API_TENANCY_OCID`
      - `OCI_EMAIL_API_USER_OCID`
      - `OCI_EMAIL_API_KEY_FINGERPRINT`
      - `OCI_EMAIL_API_PRIVATE_KEY`
      - `OCI_EMAIL_COMPARTMENT_OCID`
   - `AUTH_SECRET`
6. Optional: set `APP_ORIGIN` in Wrangler vars if the UI is served from a different trusted origin.
7. Configure `.dev.vars` for local development (see `.dev.vars.example`).

## Security Notes

- Passwords are stored using `argon2id` hashes (legacy SHA-256 hashes are upgraded automatically on successful login).
- API sessions are set as `HttpOnly` secure cookies and can also be used as bearer tokens for non-browser clients.
- Login attempts are throttled per `client-ip + username` key (`login_attempts` table in `schema.sql`).
- If this project was already deployed before this update, re-run `npm run db:migrate` to create the new table/indexes.
- Outbound email is sent with OCI Email Delivery Submission HTTPS API over TLS on port 443 and signed with OCI Signature Version 1.

## Commands

- `npm run dev` (run local server)
- `npm run typecheck` (verify types)
- `npm run deploy` (deploy to CF)
- `npm run db:create` (create DB)
- `npm run db:migrate` (migrate DB schema)

## OCI (Oracle Cloud) Setup (One-time)

These steps must be done in the OCI Console before any email can be sent outbound:
1. **Create an Email Domain:** OCI Console → Developer Services → Email Delivery → Email Domains → Create.
2. **Configure DKIM:** Go to DKIM tab → Add DKIM. Note: In Cloudflare DNS, turn the proxy (orange cloud) OFF for this CNAME record, otherwise DKIM verification fails.
3. **Configure SPF:** Add a TXT record for your domain: `v=spf1 include:rp.oracleemaildelivery.com ~all`.
4. **Create an Approved Sender:** The envelope sender and MIME `From` header must match this approved sender exactly.
5. **Create an API Key for your OCI Identity user:** Upload the public key, then copy your tenancy OCID, user OCID, key fingerprint, and private key PEM.
6. **Set submission endpoint and compartment:**
      - Endpoint: `https://cell0.submit.email.ca-montreal-1.oci.oraclecloud.com`
      - Port: `443`
      - API path used by this app: `/20220926/actions/submitRawEmail`

## Cloudflare Email Routing Setup

1. In Cloudflare Dashboard go to your domain → Email → Email Routing → Get Started.
2. Go to the **Email Workers** tab.
3. Set a **Catch-All** rule (or per-address rules):
   Action: "Send to a Worker" → select `cloudflare-webmail`
   This routes all mail for your domain to this Worker.
