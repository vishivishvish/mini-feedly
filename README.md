# miniFeedly

Minimal, always-on AI news digest. Fetches Google News RSS for a keyword,
keeps only articles from the previous day through today, resolves each
Google News redirect link to the real publisher URL, fetches the article
text, summarizes all of them in a single Gemini call, and emails a
dark-themed digest.

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
4. Summarize every article that has scraped text in **one** Gemini request
   (`summarizeAllWithGemini`) - the free tier has a low requests-per-day
   limit, so this batches all articles into a single call instead of one
   call per article. Any article Gemini doesn't return a summary for (call
   failed, key missing, response unparseable), or whose text couldn't be
   scraped at all, falls back to a verbatim first-few-sentences extract
   (`extractFirstParagraph`) - no LLM needed for that path.
5. Email the digest as a dark "command center" styled HTML dashboard
   (`composeDigestEmailHtml`), with a plain-text fallback body.

### One-time setup

1. Get a [Gemini API key](https://aistudio.google.com) and add it as a
   Script Property named `GEMINI_API_KEY` (**Project Settings > Script
   Properties**). Without it, every article just uses the verbatim
   fallback - no error, just no LLM summary.
2. **Project Settings > Time zone** -> set to `Asia/Calcutta` (so a "9am"
   trigger means 9am IST, not UTC).
3. Run `runDailyDigest` once manually to authorize permissions (external
   requests + send email).
4. **Triggers (clock icon) > Add Trigger** -> function `runDailyDigest`,
   Time-driven, Day timer, 9am-10am.

### Config constants (top of `miniFeedly.gs`)

- `KEYWORD` - search keyword (default `"Artificial Intelligence"`)
- `MAX_ITEMS` - max articles per digest (default 10)
- `RECIPIENT_EMAIL` - who gets the email
- `GEMINI_MODEL` - Gemini model used for the single batched summary call
- `FALLBACK_SUMMARY_SENTENCES` - how many sentences to pull verbatim when
  Gemini isn't used for a given article (default 3)

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
