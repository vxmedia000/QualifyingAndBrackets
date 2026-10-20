# Drift Control — Drift event control

A simple, responsive drift competition website built with static HTML, CSS and JavaScript. It is designed for GitHub Pages and keeps the event workflow in three clear steps:

1. **Drivers:** register each person and their car. Registration does not ask for points.
2. **Qualifying:** later enter Run 1 and Run 2 points. Choose best run or average to rank the grid.
3. **Bracket:** choose Top 8 / 12 / 16 / 24 / 32 / 48 / 64, generate a seeded bracket, and select battle winners. Stages are labelled Top 32 → Top 16 → Top 8 → Top 4 (depending on the selected format), followed by a Battle for 3rd and a Battle for 1st & 2nd.

Other features include a cleaner mobile-friendly layout, event settings, CSV export, live viewer mode with Supabase, and custom event backgrounds by image URL or file upload.

## 1. Preview locally

Without Supabase configuration, the app runs in local demo mode. This mode stores event data in the current browser only. Uploaded background images are compressed and stored in that browser too.

From this folder, start a local server:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

## 2. Turn on shared live updates

GitHub Pages only serves the frontend files; it does not provide a shared database. Supabase stores the event and broadcasts changes so public viewers can watch the same results and background.

1. Create a project at [Supabase](https://supabase.com/).
2. Open **SQL Editor**, paste all of `schema.sql`, and run it. The script creates the shared event row, RLS policies, Realtime publication entry, a public-read `drift-backgrounds` bucket, and authenticated upload permission. It can be rerun to refresh the background storage policies.
3. In **Authentication settings**, disable public sign-ups. Create an editor account in **Authentication → Users** for yourself and any trusted event staff.
4. Open `config.js` and enter the Supabase **Project URL** and **publishable key** (or legacy `anon` key):

   ```js
   window.DRIFT_CONFIG = {
     supabaseUrl: "https://YOUR-PROJECT.supabase.co",
     supabaseAnonKey: "YOUR-PUBLISHABLE-OR-ANON-KEY"
   };
   ```

5. Deploy to GitHub Pages using the steps below.

**Never put a Supabase `service_role` key or other secret key into `config.js`.** Browser publishable/anon keys are intended to be public; Row Level Security protects the event record, while Storage policies allow public image viewing but only authenticated image uploads.

### Background image sharing

Open **Event settings** to either enter an image URL or upload a file. The app compresses uploads to reduce file size. In local demo mode, the image is saved only in that browser. With Supabase connected, the file is uploaded to the `drift-backgrounds` bucket and the resulting public URL is saved in the shared event state so all visitors see the same background.

## 3. Deploy to GitHub Pages

1. Create a GitHub repository and upload the files directly into the repository root. In the ZIP provided with this project, `index.html`, `styles.css`, `app.js`, `config.js`, and `schema.sql` are already at the top level.
2. Open the repository's **Settings → Pages**.
3. Under the build/deployment settings, select **Deploy from a branch**, choose your main branch and `/ (root)`, and save.
4. Wait for GitHub Pages to publish the site, then open the URL shown in the Pages settings.

No build step is required. Google Fonts and the Supabase client are loaded from external CDNs, so an internet connection is needed for those extras.

## Optional developer sync-help button

The public website hides the on-page sync setup tutorial by default. In `app.js`, change `ENABLE_SYNC_HELP` from `false` to `true` only when you want the setup button and tutorial visible during development. Leave it `false` for the published event site. The sync functionality itself is unaffected.

```js
const ENABLE_SYNC_HELP = false;
```

## Optional developer test tools

Testing helpers are disabled by default so they never clutter the event UI or populate a real event. In `app.js`, find this line near the top:

```js
const ENABLE_TEST_TOOLS = false;
```

Change it to `true` to seed a local preview with 32 fictional drivers if the local roster is empty, and show the **Load 32 test drivers** / **Fill test points** buttons. This also works if you opened the site earlier and it already saved an empty roster. It will not overwrite an existing roster or auto-seed the shared Supabase event. Change it back to `false` before deploying the real event. With the flag off, sample drivers marked as test data are removed from saved client state, and any bracket built from those sample drivers is cleared; real registered drivers are kept.

## Event workflow

- Register drivers and cars in the **Drivers** tab. Each new driver starts with empty Run 1 and Run 2 fields.
- Enter qualifying points in the **Qualifying** tab whenever they become available.
- The qualifying score is the best entered run by default; Average is available in Event settings and the Qualifying toolbar.
- Select a format, then build the bracket once at least two drivers have qualifying points. Top 12 / 24 / 48 are supported and empty slots/byes are advanced automatically.
- Click a driver's name in a ready battle to record the winner. That driver advances to the next stage. The semifinal losers automatically populate **Battle for 3rd**; the semifinal winners populate **Battle for 1st & 2nd**. If you change an earlier result, dependent results are cleared. The final winner is crowned champion.
- To change bracket format or scoring after generating the bracket, reset the bracket first.
- The CSV export includes rank, driver, car, both runs, qualifying score, and qualification status.

## Files

- `index.html` — site structure
- `styles.css` — layout, background overlay, colors and animations
- `app.js` — driver registration, qualifying, bracket logic, image upload, and sync
- `config.js` — Supabase public client configuration
- `schema.sql` — shared event database, access policies, Realtime, and background storage


## If the page appears broken after deployment

- Make sure `index.html` is at the published root (or at the root of the selected `/docs` folder); do not leave it one folder down inside `drift-bracket-site/`.
- Keep `styles.css`, `app.js`, and `config.js` beside `index.html`.
- For a site that uses Supabase, configure `config.js` and run `schema.sql` first. Without Supabase, the app still works locally in that browser, but changes are not shared.
- After replacing files, wait for the GitHub Pages deployment to finish and do a hard refresh (Ctrl+F5 / Cmd+Shift+R).
