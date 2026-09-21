# Putting it on a link you can send

Target: a URL Thermal Corp can open themselves, live in about 30 minutes, costing
nothing. Vercel for the app, Neon for the database — both have real free tiers and
neither asks for a card.

Other hosts work the same way; only the click-paths differ. Railway and Render both run
this without changes, and Supabase is a drop-in for Neon.

---

## 1. Put the code on GitHub

Vercel deploys from a repository. The project is already a git repo with its history.

```
git remote add origin https://github.com/YOUR-USERNAME/thermal-mes.git
git push -u origin main
```

A **private** repository is fine — Vercel can read it once you connect the account.

`.env` is gitignored and must stay that way; the deployed copy gets its secrets from
the host, not from a file.

## 2. Create the database — Neon

1. Sign up at https://neon.tech with GitHub.
2. Create a project. Pick the region closest to Houston (`AWS us-east-2` or
   `us-west-2`).
3. On the project dashboard, copy the connection string. It looks like:

   ```
   postgresql://USER:PASSWORD@ep-something-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

   Take the **pooled** one if offered both — the app opens a connection pool per
   server instance, and the pooler is what keeps that from exhausting the free tier's
   connection limit.

Keep that string; you need it twice.

## 3. Load the schema and demo data

From your own machine, pointing the setup script at Neon instead of localhost:

**PowerShell**

```powershell
$env:DATABASE_URL="postgresql://...paste yours...?sslmode=require"
npm run db:setup
```

**macOS / Linux**

```bash
DATABASE_URL="postgresql://...paste yours...?sslmode=require" npm run db:setup
```

The script notices the host is not localhost and switches from dropping the database
(which a managed provider will not let you do) to emptying every table. Everything
else is the same: push the schema, apply the constraints, seed.

It prints `mes_dev ready` — the name in the message is just the database in the URL.

## 4. Deploy the app — Vercel

1. Sign up at https://vercel.com with the same GitHub account.
2. **Add New → Project**, pick the repository, and **do not deploy yet** — open
   *Environment Variables* first.
3. Add three:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the same Neon string, `?sslmode=require` included |
   | `AUTH_SECRET` | generate one: `openssl rand -base64 32`, or use any 32+ random characters |
   | `NEXT_PUBLIC_DEMO_BANNER` | `1` |

   `AUTH_SECRET` signs the session cookie. If it is missing the deployment builds and
   then fails at sign-in.

   `NEXT_PUBLIC_DEMO_BANNER` puts a line across the top saying the data is a
   demonstration and the routings are a guess. Leave it on. A link gets forwarded to
   people who were not in the meeting, and an unlabelled prototype is how a demo gets
   mistaken for a live system.

4. **Deploy.** First build takes two or three minutes.

You get a URL like `https://thermal-mes.vercel.app`. That is the link.

## 5. Check it before you send it

In a private browsing window, so you are not relying on a session you already have:

1. Open the URL — it should redirect to `/login`.
2. Sign in as `supervisor@thermal-corp.com` / `password123`.
3. Open **What's waiting**. If that screen has rows, the database, the schema, the
   constraints and the seed all worked.
4. Sign out, sign in as `worker3@thermal-corp.com`, open **My work**, and tap
   **Start** on a ready step. If the clock runs, the write path works too.

If sign-in bounces you back to the login page, `AUTH_SECRET` is missing or the
deployment did not pick it up — set it and redeploy.

## 6. Resetting between showings

After people have clicked around, put it back to a clean state from your machine:

```
DATABASE_URL="...neon..." npm run db:setup
```

Takes a few seconds and needs no redeploy. Worth doing the morning of the meeting.

---

## What the link is and is not

**Anyone with the URL can sign in.** The demo accounts and their password are printed
in this repo and in the seed output. That is deliberate — the point is that they can
click it without you — but it means the link is effectively public. There is nothing
confidential in the seed; if that changes, put real passwords on the accounts first.

**It is not multi-tenant, backed up, or monitored.** Neon's free tier suspends an idle
database, so the first page load after a quiet period takes a few seconds. Mention that
rather than letting them think the software is slow.

**Free-tier limits worth knowing:** Neon free gives 0.5 GB and suspends after five
minutes idle. Vercel Hobby is for non-commercial use — fine for a demonstration, not
for Thermal Corp actually running production on it. When it becomes a real deployment,
that is a different conversation about hosting, backups and access control.

## If you would rather not use Vercel

- **Railway** — creates the Postgres for you and deploys from the same repo; one
  service, one database, same three environment variables.
- **Render** — same shape, free web service sleeps when idle.
- **A plain VPS** — `npm run build` then `npm start` behind nginx; the app is an
  ordinary Node server and needs nothing special.
