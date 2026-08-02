# miniFeedly

Minimal, always-on AI news digest. Fetches Google News RSS for a keyword,
keeps only articles from the previous day through today, resolves each
Google News redirect link to the real publisher URL, fetches the article
text, pulls its first few sentences verbatim, and emails a dark-themed
digest.

## Deployed pipeline: Google Apps Script (`miniFeedly.gs`)

This is what actually runs daily. It lives in a Google Apps Script project
(not this repo directly - paste `miniFeedly.gs` into the Apps Script editor),
scheduled via a time-driven trigger.

Pipeline per run:
1. Fetch Google News RSS for `KEYWORD`, filter to items published in the
   previous-day-to-today UTC window, cap at `MAX_ITEMS`.
2. Resolve each Google News redirect link to the real publisher URL via
   Google's internal `batchexecute` RPC (no browser needed - works from a
   headless script).
3. Fetch each real article's page and strip it down to plain text. Some
   publishers (paywalled or bot-blocking) will fail here - expected, not
   an error.
4. Extract the first few sentences of that text verbatim as the "First
   Paragraph" (`extractFirstParagraph`) - no LLM call, no API keys needed.
5. Email the digest as a dark "command center" styled HTML dashboard
   (`composeDigestEmailHtml`), with a plain-text fallback body.

### One-time setup

1. **Project Settings > Time zone** -> set to `Asia/Calcutta` (so a "9am"
   trigger means 9am IST, not UTC).
2. Run `runDailyDigest` once manually to authorize permissions (external
   requests + send email).
3. **Triggers (clock icon) > Add Trigger** -> function `runDailyDigest`,
   Time-driven, Day timer, 9am-10am.

### Config constants (top of `miniFeedly.gs`)

- `KEYWORD` - search keyword (default `"Artificial Intelligence"`)
- `MAX_ITEMS` - max articles per digest (default 10)
- `RECIPIENT_EMAIL` - who gets the email
- `FIRST_PARAGRAPH_SENTENCES` - how many sentences to pull as the "First
  Paragraph" (default 3)

## Reference implementation: `fetch_digest.py`

A Python port of the same fetch/filter/resolve/extract logic, runnable and
tested locally (`python3 fetch_digest.py "Artificial Intelligence" 10`).
It was the original prototype for the pipeline above and is kept here for
local testing/reference - it is not what runs on a schedule. It prints a
plain-text digest and saves each run's raw data to `Runs/run_<timestamp>.xml`
(JSON content, `.xml` extension by design).

## `email_preview.html`

Standalone static preview of the HTML email's dark "command center" design,
openable directly in a browser - useful for iterating on the email's look
without needing to trigger a real run.
