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

The "Sign in with Google" button on Manage Listing currently shows a design-review mock (a fake account picker), because real Google Sign-In needs to be registered to a specific domain — which didn't exist until step 3 above.

Once you have your Netlify URL (or custom domain):

1. Go to [Google Cloud Console](https://console.cloud.google.com) → create a project (or use an existing one) → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID → Web application**.
3. Under **Authorized JavaScript origins**, add your Netlify URL (e.g. `https://sharedclassrooms.netlify.app`) and `http://localhost:5173` if you want it to also work locally.
4. Copy the generated **Client ID** into `VITE_GOOGLE_CLIENT_ID` (both in your local `.env` and in Netlify's environment variables), then redeploy.

Note: swapping in the real Google button is a separate follow-up from this batch of work — right now the app still uses the mock regardless of this variable. Let me know when you've got the domain and Client ID ready, and I'll wire in the real button and the token verification it needs.

## Known gaps, worth tracking deliberately

These were flagged during earlier testing and are still true after this migration — noting them here so they don't get lost:

- **Admin passcode is checked in the browser.** Anyone who opens dev tools can read it out of the built code. Fine for an internal pilot, not for public use.
- **Row Level Security is wide open** (see `supabase/schema.sql`). Same underlying issue as the passcode — no real per-user identity yet to restrict access by.
- **Photos are stored as compressed data embedded directly in each listing**, not as separate files. Works fine for one photo per classroom at small scale; once real photo galleries matter, Supabase Storage (which you now have access to) is the natural next step.
- **Google Sign-In needs server-side token verification** to be genuinely secure, not just the client-side email match currently planned — a small serverless function (a Netlify Function is the natural fit) rather than a full backend.
