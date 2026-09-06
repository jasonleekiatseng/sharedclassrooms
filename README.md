# SharedClassrooms

A marketplace connecting tuition centers' spare classroom time with tutors who need occasional group class space.

This is a real, deployable project (Vite + React + Supabase) — not the single-file preview you were testing inside Claude.ai. The steps below take it from "code on your computer" to "live on the internet."

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com), sign up / log in, and create a new project (pick any name and a strong database password — save that password somewhere, you likely won't need it day-to-day but it's your project's master key).
2. Once it's created, go to **Project Settings → API**. You'll need two values from this page shortly: **Project URL** and the **anon / public** key.
3. Go to **SQL Editor → New query**, paste in the entire contents of `supabase/schema.sql` (in this project), and click **Run**. This creates the `centers`, `listings`, and `inquiries` tables.
   - Read the comment block above the Row Level Security section in that file before you rely on this for anything beyond internal testing — the policies are intentionally open for now (matches how the app already behaved), and that's a real gap to close before strangers can reach the URL.

## 2. Run it locally

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in the two Supabase values from step 1:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Leave `VITE_GOOGLE_CLIENT_ID` blank for now — see the Google Sign-In note below.

```bash
npm run dev
```

This opens the app at `http://localhost:5173` (or similar), now reading and writing to your real Supabase database instead of Claude.ai's artifact storage. Everything — Browse, List your space, Manage listing, Admin — works the same as what you tested, just backed by a real database that anyone with the deployed URL can reach.

## 3. Deploy to Netlify

1. Push this project to a GitHub (or GitLab/Bitbucket) repository.
2. In Netlify, **Add new site → Import an existing project**, and connect that repository. Netlify should auto-detect the build settings from `netlify.toml` (`npm run build`, publish directory `dist`) — confirm and deploy.
3. Before or after the first deploy, go to **Site settings → Environment variables** and add the same three variables from your `.env` file (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_GOOGLE_CLIENT_ID` once you have it). Trigger a redeploy after adding them if the first deploy ran before you added them.
4. You'll get a free `your-site-name.netlify.app` URL immediately. A custom domain can be attached later under **Domain settings**.

## 4. Google Sign-In (Manage Listing) — do this once you have a real domain

The "Sign in with Google" button on Manage Listing is now wired to real Google Identity Services, with the sign-in verified server-side by a Netlify Function (`netlify/functions/verify-google-signin.js`) before the app trusts the email it returns. It automatically falls back to the earlier design-review mock if `VITE_GOOGLE_CLIENT_ID` isn't set — handy for working on the UI locally without needing real Google credentials.

To turn on the real thing:

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project (or use an existing one) → **APIs & Services → OAuth consent screen** → configure it (External, fill in the required fields, Testing mode is fine to start).
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
3. Under **Authorized JavaScript origins**, add your real domain (e.g. `https://sharedclassrooms.netlify.app`) and `http://localhost:5173` for local testing.
4. Copy the generated **Client ID** into `VITE_GOOGLE_CLIENT_ID` — in your local `.env`, and in Netlify's environment variables (the Netlify Function reads the same variable server-side, so one value covers both).
5. Redeploy. The real Google button should now appear instead of the mock, and a completed sign-in gets verified against Google before the app matches it to a center.

Note: a center's email has to match exactly what they typed in at intake (case-insensitive) for their Google sign-in to be recognized. If that becomes a real friction point, the next step is remembering each center's linked Google account by its permanent account ID after the first successful match, rather than re-matching by email every time — not built yet, flagging it as a natural next refinement.

## Known gaps & planned future development

These were flagged deliberately along the way — noting them here so nothing gets lost between sessions:

- **Admin passcode is an environment variable now (`VITE_ADMIN_PASSCODE`), not hardcoded — but it's still checked in the browser.** Changing it no longer requires a code edit or leaves old values in your Git history, which is a real improvement. It's still not real authentication though: anyone who opens dev tools on the built site can read the passcode's value straight out of the loaded JavaScript, since it has to be sent to the browser to be checked there. Fine for an internal pilot, not for public use — the actual fix is moving this check to a server, once real per-user auth replaces the open RLS policies below.
- **Row Level Security is wide open** (see `supabase/schema.sql`). Same underlying issue as the passcode — no real per-user identity yet to restrict access by.
- **No delete/archive action in Admin.** Deliberate for now — every other Admin action changes status (flag, suspend, ban), never erases history, and a real delete is a bigger, more irreversible step than the current security posture should carry. Cleanup today happens by asking Claude to run it directly against Supabase. Worth adding a proper soft-delete (an `archived` flag, not a real `DELETE`) once real per-user auth replaces the open RLS policies above.
- **The inquiry status (New / Contacted / KIV / Confirmed lease / Declined) is currently just a freely-editable tracking note for the center owner** — a personal CRM-style toggle, not a system action. Changing it doesn't push anything into the center's linked Google Calendar and doesn't reduce the listing's advertised availability. A real "Confirm" action that actually does both is planned for a future update (needs the Google Calendar API, plus deciding how "advertised hours" and "actually booked hours" relate to each other) — deliberately deferred rather than half-built.
- **PayNow (or any payment gateway) isn't integrated.** Needs a business-model decision first (is SharedClassrooms charging its own marketplace fee, or handling money between tutor and center — the second is a meaningfully bigger regulatory question under Singapore's Payment Services Act). Once decided: needs a real merchant account (HitPay is the likely fit for PayNow specifically) and a backend function to create/verify payments, similar shape to the Google Sign-In verification function.
- **No email, WhatsApp, or SMS notifications.** Needed for centers to actually hear about new booking requests without checking the site. Needs a real backend piece (a Netlify Function, same pattern as Google Sign-In verification) plus a paid provider account — email is straightforward (e.g. Resend), WhatsApp Business API is a meaningfully bigger lift than SMS.
- **Photos** are stored as real files in Supabase Storage (multiple per classroom, uploaded directly) — this one's done, not a gap; kept here crossed off for the record since it used to be a stopgap.
