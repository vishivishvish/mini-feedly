# mini-feedly

A Feedly-like multi-keyword news tracker that runs entirely out of a
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
- **AI article summaries** - built into `runDailyDigest`, so summaries land
  as soon as articles do: every article whose text can be extracted from its
  real publisher URL goes into one batched request to NVIDIA's Nemotron 3
  Ultra API (`nvidia/nemotron-3-ultra-550b-a55b`) - one JSON array of
  articles in, one JSON object of summaries out - instead of a separate API
  call per article, since NVIDIA rate-limits to 40 requests/minute. Articles
  whose text can't be extracted (paywalls, JS-rendered pages, blocks), or
  whose batch call fails outright, get "Summary Not Available" instead.
  `summarizeArticles` (run manually) backfills the same way for Sheet rows
  tracked before this feature existed. The web app shows whatever's in that
  column below the article title. By default `summarizeArticles` only picks
  up rows with a blank Summary cell, so a row already marked "Summary Not
  Available" is left alone on future runs; set `RETRY_FAILED_SUMMARIES` to
  `true` to have it also retry those rows instead of just blank ones.
- **Per-article notes** - an "Add Notes"/"Edit Notes" button on every article
  card opens a small text box; whatever you type is saved via
  `saveArticleNote` to that row's `Notes` column (matched by keyword + URL)
  and shown in italic, pale-yellow text below the summary from then on.
  Purely personal annotations - never sent to NVIDIA or included in the
  digest email.

## Deployed pipeline: Google Apps Script (`mini-feedly.gs` + `Index.html`)

This is what actually runs. It lives in a Google Apps Script project (not
this repo directly - paste both files into the Apps Script editor,
`Index.html` as a separate HTML file named exactly `Index`).

**Daily digest (`runDailyDigest`, time-driven trigger):**
1. For each keyword in `KEYWORDS`: fetch Google News RSS, filter to items
   published in the previous-day-to-today UTC window, cap at
   `MAX_ITEMS_PER_KEYWORD`, and sort them newest-first by parsed `PubDate`
   (`parseFeedItems` doesn't trust Google's feed ordering implicitly).
2. Resolve each Google News redirect link to the real publisher URL via
   Google's internal `batchexecute` RPC (no browser needed - works from a
   headless script).
3. Pool every keyword's fresh items together and run them through
   `summarizeInBatches_` - one batched Nemotron request per
   `SUMMARIZE_BATCH_SIZE` items (a normal day's volume fits in a single
   call), setting each item's summary in place before anything is written
   to the Sheet.
4. Append any article not already stored for that keyword (deduped by URL)
   to the `Articles` Sheet tab, tagged with the date it was first seen and
   its summary (or "Summary Not Available"). New rows are inserted right
   below the header rather than appended at the bottom, so the Sheet itself
   reads newest-first top-to-bottom.
5. Email one digest covering every keyword: title + real URL for each of
   that keyword's articles from this run, sectioned by keyword, styled as a
   dark "command center" HTML dashboard (`composeDigestEmailHtml`) with a
   plain-text fallback body (`composeDigestEmail`). Summarization failures
   never affect this step - the email always sends.

**Web app (`doGet` / `Index.html`):** a sidebar of tracked keywords (each
with its total article count, via `getKeywordCounts()`) and a main panel
listing the selected keyword's history newest first (sorted explicitly by
parsed `PubDate` in `getArticlesPage()`, not assumed from Sheet row order),
`PAGE_SIZE` articles at a time, each entry showing source, title, link, and
the date it was first tracked. Switching keywords or clicking "See More"
calls `getArticlesPage()`
for the next batch. A search box above the list filters whatever's currently
loaded (title/source, case-insensitive) purely client-side - switching
keywords or loading a fresh page resets it. Each card also shows whatever's
in that row's Summary column (from `summarizeArticles`, see below), if
anything, plus an "Add Notes"/"Edit Notes" button that opens a text box for
a personal note on that article - saved via `saveArticleNote()` and shown in
italic, pale-yellow text below the summary. Reads directly from the
`Articles` Sheet - no separate data store from the daily digest.

**Summarization internals:** `extractArticleText_` best-effort scrapes an
article's real publisher URL (prefers an `<article>` tag, strips
script/style/nav/footer and remaining markup); text shorter than
`MIN_EXTRACTED_TEXT_LENGTH` is treated as a failed extraction (usually a
paywall or block page). `summarizeBatchWithNemotron_` sends one request for
up to `SUMMARIZE_BATCH_SIZE` articles' extracted text - a JSON array of
`{id, title, text}` in, a JSON object of `{id: summary}` out - and returns
`null` (never throws) on a missing API key, HTTP error, or unparseable
response. `summarizeBatch_` ties the two together for one chunk: articles
with no extractable text get `SUMMARY_NOT_AVAILABLE` immediately; if the
batch call itself fails, every article in that chunk falls back to
`SUMMARY_NOT_AVAILABLE` too, per-article, not just the ones that failed
extraction. `summarizeInBatches_` (used by `runDailyDigest`) chunks a list
of fresh items and paces multiple chunks with `NVIDIA_RATE_LIMIT_DELAY_MS`;
`summarizeArticles` (run manually) does the same for any Sheet rows with a
blank Summary cell - or, with `RETRY_FAILED_SUMMARIES` set to `true`, rows
marked `SUMMARY_NOT_AVAILABLE` too - oldest first, capped at
`MAX_SUMMARIES_PER_RUN` per run, writing each chunk's results to the Sheet
immediately so progress survives an interrupted run - for backfilling rows
tracked before this feature existed, retrying rows that failed, or
backfilling rows from before `NVIDIA_API_KEY` was set. Rows added by
`runDailyDigest` going forward already have a summary (or "Summary Not
Available") by the time they're written - no separate backfill step needed
for new articles.

### One-time setup

1. Paste `mini-feedly.gs` and `Index.html` into an Apps Script project
   (`Index.html` as a separate HTML file, named exactly `Index`).
2. Edit the `KEYWORDS` array in `mini-feedly.gs` to the topics you want
   tracked.
3. Run `runDailyDigest` once manually to authorize permissions (external
   requests, Sheets, send email) - this also creates the backing
   "mini-feedly Data" Sheet on first run and stores its ID in this script's
   Script Properties.
4. **Project Settings > Time zone** -> set to `Asia/Kolkata` (the modern
   IANA name for IST, so a "9am" trigger means 9am IST, not UTC).
5. **Triggers (clock icon) > Add Trigger** -> function `runDailyDigest`,
   Time-driven, Day timer, 9am-10am.
6. **Deploy > New deployment > Web app**. Execute as: **Me**. Who has
   access: **Only myself** (or your Workspace domain). Copy the web app
   URL - that's your tracker bookmark.
7. To ship code changes later **without changing that URL**: **Deploy >
   Manage deployments** > pick the existing deployment > pencil/Edit icon >
   Version: **New version** > Deploy.
8. **Project Settings > Script Properties** -> add a property named
   `NVIDIA_API_KEY` with a key from [build.nvidia.com](https://build.nvidia.com).
   Never put the key directly in `mini-feedly.gs` - this repo is public.
   Without this property, `runDailyDigest` still runs fine - articles just
   get "Summary Not Available" instead of a real summary. After adding the
   key, run `summarizeArticles` manually once (function dropdown in the
   editor) to backfill rows tracked before it was set.

### Data model (Sheet, auto-created on first run)

- `Articles`: Keyword, Title, Source, PubDate, Url, FirstSeenDate, Summary,
  Notes (`Url` is the resolved real publisher URL, not the Google News
  redirect link; `Keyword` must match a `KEYWORDS` entry exactly,
  case-sensitive, or the web app won't group that row under any sidebar
  entry; `Summary` is filled in by `runDailyDigest` itself for new rows -
  blank only for rows tracked before summarization existed, until
  `summarizeArticles` backfills them - and holds either an NVIDIA-generated
  summary or "Summary Not Available"; `Notes` is blank until you add one
  from the web app)
- Sheets created before summarization/notes existed get the `Summary` /
  `Notes` columns added automatically the next time the sheet is opened by
  the script (`ensureSummaryColumn_` / `ensureNotesColumn_`) - no manual
  migration needed.
- The Sheet is referenced by its permanent Drive file ID (stored in this
  script's Script Properties), never by path, so it can be moved between
  Drive folders at any time without breaking anything.

### Config constants (top of `mini-feedly.gs`)

- `KEYWORDS` - array of tracked search keywords (default
  `["Artificial Intelligence", "Robotics"]`)
- `MAX_ITEMS_PER_KEYWORD` - max articles fetched/emailed per keyword per run
  (default 10)
- `PAGE_SIZE` - how many articles the web app loads per keyword per "See
  More" click, and how many load on first open of a keyword (default 20)
- `RECIPIENT_EMAIL` - who gets the daily digest email
- `NVIDIA_MODEL` - which NVIDIA-hosted model summarization calls (default
  `nvidia/nemotron-3-ultra-550b-a55b` - verify this slug still matches the
  current listing at build.nvidia.com if NVIDIA renames it)
- `SUMMARIZE_BATCH_SIZE` - articles per single Nemotron request (default 20
  - `KEYWORDS.length * MAX_ITEMS_PER_KEYWORD` stays under this by default,
  so a normal `runDailyDigest` run needs exactly one summarization call)
- `NVIDIA_RATE_LIMIT_DELAY_MS` - pause between batch calls, only when a run
  needs more than one batch (default 1600ms, safely under NVIDIA's 40 RPM
  cap)
- `MAX_SUMMARIES_PER_RUN` - cap on rows processed per `summarizeArticles`
  run, to stay within Apps Script's execution time limit (default 150)
- `MIN_EXTRACTED_TEXT_LENGTH` / `MAX_EXTRACTED_TEXT_LENGTH` - extracted
  article text shorter than the min is treated as a failed extraction
  (paywall/block page); text longer than the max gets truncated before
  being sent to NVIDIA (defaults 400 / 6000 characters)
- `RETRY_FAILED_SUMMARIES` - when `true`, `summarizeArticles` treats rows
  marked "Summary Not Available" as pending too, not just blank ones, so a
  manual run retries them (default `false`)

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
