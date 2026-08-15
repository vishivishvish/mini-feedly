# mini-feedly

A Feedly-like news tracker that runs entirely out of a
Google Apps Script project: no external hosting, no separate login beyond
your own Google account. Every article tracked gets a permanent home in a
Sheet, so nothing is lost once it scrolls out of a daily email.

## Features

Keep this list current whenever a feature is added or changed.

- **Multiple tracked keywords** - `KEYWORDS` is an array, not a single
  string; each one is fetched, tracked, and emailed independently.
- **Persistent per-keyword article history** - every article ever fetched
  is appended to a Sheet (deduped by URL, per keyword), so re-running never
  creates duplicates of a story Google News re-surfaces on a later day.
- **Web app tracker** (`doGet`) - a Feedly-style page with one section per
  keyword, showing that keyword's history newest-first, `PAGE_SIZE` articles
  at a time with a "See More" button to pull the next `PAGE_SIZE` from the
  Sheet - the Sheet itself keeps everything, and paging never re-fetches
  articles already loaded.
- **Daily 9am digest email** - plain title + real publisher URL for up to
  `MAX_ITEMS_PER_KEYWORD` articles per keyword from the previous-day-to-today
  window, one section per keyword, dark "command center" styled HTML with a
  plain-text fallback body. No article scraping and no LLM call in this
  path - just title, source, publish date, and a working link.
- **Real URL resolution** - Google News wraps links behind a client-side
  redirect; `resolveRealUrl` replicates Google's internal `batchexecute` RPC
  to get the real publisher URL from a headless script.
- **Client-side filter box** - a search input above the article list filters
  the currently-loaded articles by title/source as you type, entirely in the
  browser (no server round-trip, no new Sheet columns). Only searches
  articles already paged in - it doesn't query the Sheet for older ones.

## Deployed pipeline: Google Apps Script (`mini-feedly.gs` + `Index.html`)

This is what actually runs. It lives in a Google Apps Script project (not
this repo directly - paste both files into the Apps Script editor,
`Index.html` as a separate HTML file named exactly `Index`).

**Daily digest (`runDailyDigest`, time-driven trigger):**
1. For each keyword in `KEYWORDS`: fetch Google News RSS, filter to items
   published in the previous-day-to-today UTC window, cap at
   `MAX_ITEMS_PER_KEYWORD`.
2. Resolve each Google News redirect link to the real publisher URL via
   Google's internal `batchexecute` RPC (no browser needed - works from a
   headless script).
3. Append any article not already stored for that keyword (deduped by URL)
   to the `Articles` Sheet tab, tagged with the date it was first seen.
4. Email one digest covering every keyword: title + real URL for each of
   that keyword's articles from this run, sectioned by keyword, styled as a
   dark "command center" HTML dashboard (`composeDigestEmailHtml`) with a
   plain-text fallback body (`composeDigestEmail`).

**Web app (`doGet` / `Index.html`):** a sidebar of tracked keywords (each
with its total article count, via `getKeywordCounts()`) and a main panel
listing the selected keyword's history newest first, `PAGE_SIZE` articles at
a time, each entry showing source, title, link, and the date it was first
tracked. Switching keywords or clicking "See More" calls `getArticlesPage()`
for the next batch. A search box above the list filters whatever's currently
loaded (title/source, case-insensitive) purely client-side - switching
keywords or loading a fresh page resets it. Reads directly from the
`Articles` Sheet - no separate data store from the daily digest.

### One-time setup

1. Paste `mini-feedly.gs` and `Index.html` into an Apps Script project
   (`Index.html` as a separate HTML file, named exactly `Index`).
2. Edit the `KEYWORDS` array in `mini-feedly.gs` to the topics you want
   tracked.
3. Run `runDailyDigest` once manually to authorize permissions (external
   requests, Sheets, send email) - this also creates the backing
   "mini-feedly Data" Sheet on first run and stores its ID in this script's
   Script Properties.
4. **Project Settings > Time zone** -> set to `Asia/Calcutta` (the legacy
   IANA name for `Asia/Kolkata`/IST, so a "9am" trigger means 9am IST, not
   UTC).
5. **Triggers (clock icon) > Add Trigger** -> function `runDailyDigest`,
   Time-driven, Day timer, 9am-10am.
6. **Deploy > New deployment > Web app**. Execute as: **Me**. Who has
   access: **Only myself** (or your Workspace domain). Copy the web app
   URL - that's your tracker bookmark.
7. To ship code changes later **without changing that URL**: **Deploy >
   Manage deployments** > pick the existing deployment > pencil/Edit icon >
   Version: **New version** > Deploy.

### Data model (Sheet, auto-created on first run)

- `Articles`: Keyword, Title, Source, PubDate, Url, FirstSeenDate (`Url` is
  the resolved real publisher URL, not the Google News redirect link;
  `Keyword` must match a `KEYWORDS` entry exactly, case-sensitive, or the
  web app won't group that row under any sidebar entry)
- The Sheet is referenced by its permanent Drive file ID (stored in this
  script's Script Properties), never by path, so it can be moved between
  Drive folders at any time without breaking anything.

### Config constants (top of `mini-feedly.gs`)

- `KEYWORDS` - array of tracked search keywords (default
  `["Artificial Intelligence", "Robotics"]`)
- `MAX_ITEMS_PER_KEYWORD` - max articles fetched/emailed per keyword per run
  (default 10)
- `PAGE_SIZE` - how many articles the web app loads per keyword per "See
  More" click (default 20)
- `RECIPIENT_EMAIL` - who gets the daily digest email

## Reference implementation: `fetch_digest.py`

A Python port of the original single-keyword fetch/filter/resolve/extract
logic, runnable and tested locally (`python3 fetch_digest.py "Artificial Intelligence" 10`).
It was the original prototype for the pipeline above and is kept here for
local testing/reference - it is not what runs on a schedule, and it hasn't
been updated for the multi-keyword/Sheet-history/no-summary changes above.
It prints a plain-text digest and saves each run's raw data to
`Runs/run_<timestamp>.xml` (JSON content, `.xml` extension by design).

## `email_preview.html`

Standalone static preview of the HTML email's dark "command center" design,
openable directly in a browser - useful for iterating on the email's look
without needing to trigger a real run. Note: this predates the summary
removal and multi-keyword sectioning, so it doesn't reflect the current
email format.
