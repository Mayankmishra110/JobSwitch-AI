# Deployment

Target architecture is ADR Option C: a static frontend on a CDN, one small VPS
running the API and workers, and **managed** Postgres.

> **Nothing is deployed yet.** No VPS, domain, or managed database exists. This
> document is the runbook for when you provision them. The application has been
> smoke-tested over real HTTP locally, which is not the same as having run in
> production.
>
> Provider names and free-tier terms move, so verify pricing and — importantly —
> **licensing** before committing. Some popular free tiers are licensed for
> non-commercial use only, and a SaaS in free beta generally falls outside that.

---

## 1. Provision

| Component | What to get | Notes |
|---|---|---|
| Postgres | Managed, 16+, with `pgvector` | The one thing worth paying for. Backups and PITR are what you least want to own. |
| Compute | 1 small VPS, 2 vCPU / 2–4 GB | Runs `web` now, plus `worker` and `scheduler` from Phase 2, plus the embedding model from Phase 5. |
| Object storage | Bucket with **zero egress fees** | Not needed until Phase 4 (résumés). Egress pricing is where this gets expensive. |
| DNS + CDN | Automatic TLS on all hosts | |
| Email | Provider with a verified sending domain | Phase 8. |

## 2. Database roles

Migrations create the group roles (`app_web`, `app_ingest`, `app_matcher`).
You create the login roles and grant membership.

```sql
CREATE ROLE app_web_prod     LOGIN PASSWORD '<generated>';
CREATE ROLE app_ingest_prod  LOGIN PASSWORD '<generated>';
CREATE ROLE app_matcher_prod LOGIN PASSWORD '<generated>';

GRANT app_web     TO app_web_prod;
GRANT app_ingest  TO app_ingest_prod;
GRANT app_matcher TO app_matcher_prod;

-- app_matcher_prod ALSO needs this next line - see the callout below.
ALTER ROLE app_matcher_prod BYPASSRLS;
```

**The application must never connect as the database owner.** The owner
bypasses RLS, so running the app as the owner turns tenant isolation off
without any error, log line, or failing test. It is the single most damaging
misconfiguration available in this system.

**`app_matcher_prod` needs its own explicit `BYPASSRLS`, and this is easy to
get wrong.** `BYPASSRLS` is a role *attribute*, not a privilege - unlike the
table grants `app_matcher` carries, Postgres deliberately does **not**
propagate role attributes (`LOGIN`, `SUPERUSER`, `BYPASSRLS`, ...) through
`GRANT` membership, even with the default `INHERIT` behavior. `GRANT
app_matcher TO app_matcher_prod` alone gives `app_matcher_prod` every table
privilege `app_matcher` holds, but leaves `app_matcher_prod`'s own
`rolbypassrls` at `false` - the matcher service would then fail every write
with "new row violates row-level security policy," exactly as if `app_matcher`
had never been granted `BYPASSRLS` in migration `0001` at all. This was found
by `services/matcher`'s own integration tests failing against a real
database, not by inspection - the equivalent mistake in the test suite's own
role setup was the first thing it caught (see
`services/matcher/internal/match/match_integration_test.go`).

Verify after deploying:

```sql
-- app_web_prod: should be false. If true, RLS is not protecting anything.
SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'app_web_prod';

-- app_matcher_prod: should be TRUE. If false, the matcher cannot write
-- job_match rows for any account - the opposite failure mode, but still a
-- broken deploy.
SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_matcher_prod';
```

## 3. DNS

| Record | Host | Points at |
|---|---|---|
| `A` / `CNAME` | `yourdomain.com` | CDN — marketing site |
| `CNAME` | `app.yourdomain.com` | CDN — application |
| `A` / `CNAME` | `api.yourdomain.com` | CDN proxy → VPS |

Keep the VPS behind the CDN rather than exposing it directly, and firewall the
origin to the CDN's ranges plus your SSH address.

Separating `api.` is what makes extension CORS explicit and auditable in one
place when Phase 7 arrives.

## 4. Environment

Set from `.env.example`. In production specifically:

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables HSTS and the Secure cookie flag |
| `DATABASE_URL` | the **app_web** role | Never the owner |
| `DATABASE_URL_MATCHER` | the **app_matcher** role (`BYPASSRLS`, see §2) | `services/matcher` only - never used by `apps/web` |
| `DATABASE_URL_MIGRATE` | the owner role | Deploy step only, never in the running app |
| `DATABASE_SSL` | `true` | |
| `SESSION_SECRET` | `openssl rand -base64 48` | Rotating it signs everyone out |
| `APP_ORIGIN` | `https://app.yourdomain.com` | Builds reset links |
| `TRUST_PROXY` | `true` | **Only** because there is a real proxy in front. Setting it without one lets clients spoof `X-Forwarded-For` and evade rate limits |
| `MAIL_TRANSPORT` | a real provider | `log` prints reset links into your logs |

## 5. Deploy sequence

```bash
docker build -t jobswitch:$(git rev-parse --short HEAD) .

# Migrate as a separate step, with the owner role, BEFORE starting new
# containers. The web image deliberately cannot do this: a process that
# migrates on boot races every other instance during a rolling deploy and
# needs DDL rights the application must not hold.
DATABASE_URL_MIGRATE=... pnpm migrate

docker run -d --env-file .env.production -p 3000:3000 jobswitch:<sha>

curl -fsS https://api.yourdomain.com/readyz
```

`/readyz` returns 503 and lists pending migrations when the schema is behind,
so a mis-ordered deploy is visible rather than mysterious.

## 6. Backups — the step people skip

Managed Postgres gives you automated backups. That is not the same as having a
restore.

**Restore-test once before launch, then quarterly.** Restore into a scratch
database and run `pnpm migrate:status` plus a row count against it. An untested
backup is a belief, not a backup, and this is the one failure you cannot
apologise your way out of.

## 7. Before the first real user

Launch blockers, not features:

- [ ] Restore-tested backup
- [ ] `app_web_prod` confirmed to have neither `rolsuper` nor `rolbypassrls`
- [ ] `SESSION_SECRET` generated, not the example value
- [ ] Real mail transport configured; SPF, DKIM and DMARC on the sending domain
- [ ] Privacy policy naming every third-party processor, including the model provider
- [ ] Terms of service
- [ ] Working self-service export and deletion (DPDP requirement)
- [ ] Published contact for companies to request removal from the index
- [ ] `TRUST_PROXY` matches reality
