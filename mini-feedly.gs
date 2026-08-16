/**
 * mini-feedly - Google Apps Script version
 *
 * Three things running out of this one project:
 * 1. A daily 9am trigger (`runDailyDigest`) that fetches Google News RSS for
 *    each tracked keyword, resolves each Google News redirect link to the
 *    real publisher URL, appends any articles not already seen to a
 *    persistent Sheet (deduped by URL, per keyword), and emails a plain
 *    title + URL digest - no article scraping, no LLM summary call.
 * 2. A web app (`doGet`) that reads that same Sheet and shows a Feedly-like
 *    per-keyword history of every article ever tracked, `PAGE_SIZE` articles
 *    at a time (newest first) with a "See More" button to page through the
 *    rest - the Sheet itself keeps everything regardless of how much of it
 *    has been paged through.
 * 3. An on-demand batch job (`summarizeArticles`, run manually) that, for
 *    every Sheet row still missing a Summary, tries to extract the article's
 *    text from its real publisher URL and asks NVIDIA's Nemotron 3 Ultra API
 *    to summarize it, respecting NVIDIA's 40-requests/minute rate limit.
 *    Rows whose text can't be extracted get "Summary Not Available" instead
 *    of an API call. The web app shows whatever's in that column.
 *
 * SETUP (one-time):
 * 1. Paste this file and Index.html into an Apps Script project (Index.html
 *    as a separate HTML file, named exactly "Index").
 * 2. Edit the `KEYWORDS` array below to the topics you want tracked.
 * 3. Run `runDailyDigest` once manually to authorize permissions (external
 *    requests, Sheets, send email) and create the backing Sheet on first run.
 * 4. Set project timezone to Asia/Kolkata (Project Settings) so a "9am"
 *    trigger means 9am IST.
 * 5. Triggers (clock icon) > Add Trigger > function: runDailyDigest,
 *    Time-driven, Day timer, 9am - 10am.
 * 6. Deploy > New deployment > Web app. Execute as: Me. Who has access:
 *    Only myself (or your Workspace domain). Copy the web app URL.
 * 7. To ship code changes later WITHOUT changing that URL: Deploy > Manage
 *    deployments > pick the existing deployment > Edit (pencil) > Version:
 *    New version > Deploy.
 * 8. Project Settings > Script Properties > add `NVIDIA_API_KEY` with a key
 *    from build.nvidia.com. Never put the key in this source file - it's
 *    committed to a repo. Run `summarizeArticles` manually whenever you want
 *    to backfill summaries for rows that don't have one yet (new rows added
 *    by `runDailyDigest` start without a summary until this runs again).
 */

const KEYWORDS = ["Artificial Intelligence", "Robotics"];
const MAX_ITEMS_PER_KEYWORD = 10;
const PAGE_SIZE = 20;
const RECIPIENT_EMAIL = "vishnu.subramanian1@mygreatlearning.com";

const SHEET_NAMES = {
  ARTICLES: "Articles",
};

const ARTICLE_HEADERS = ["Keyword", "Title", "Source", "PubDate", "Url", "FirstSeenDate", "Summary"];

// ---- Summarization (NVIDIA Nemotron 3 Ultra) ----

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// Verify this slug still matches the current listing at build.nvidia.com if NVIDIA renames/retires it.
const NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_RATE_LIMIT_DELAY_MS = 1600; // ~37 requests/min, safely under NVIDIA's 40 RPM cap
const MAX_SUMMARIES_PER_RUN = 150; // keeps one run comfortably within Apps Script's execution time limit
const MIN_EXTRACTED_TEXT_LENGTH = 400; // shorter usually means a paywall/blocked fetch, not real article text
const MAX_EXTRACTED_TEXT_LENGTH = 6000; // keeps the summarization prompt small and fast
const SUMMARY_NOT_AVAILABLE = "Summary Not Available";

// ---- Daily digest: fetch, dedupe/append to Sheet, email ----

function runDailyDigest() {
  try {
    const keywordResults = KEYWORDS.map(function (keyword) {
      const items = fetchDigestItems(keyword, MAX_ITEMS_PER_KEYWORD);
      appendNewArticles_(keyword, items);
      return { keyword: keyword, items: items };
    });

    const subject = "mini-feedly Daily Digest - " + Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
    const textBody = composeDigestEmail(keywordResults);
    const htmlBody = composeDigestEmailHtml(keywordResults);
    MailApp.sendEmail({
      to: RECIPIENT_EMAIL,
      subject: subject,
      body: textBody,
      htmlBody: htmlBody,
    });

    const total = keywordResults.reduce(function (sum, r) { return sum + r.items.length; }, 0);
    Logger.log("Digest sent: %s keyword(s), %s article(s) total.", keywordResults.length, total);
  } catch (err) {
    // Never fail silently - email the error so a broken run is still visible.
    MailApp.sendEmail(
      RECIPIENT_EMAIL,
      "mini-feedly Daily Digest - ERROR",
      "The daily digest run failed:\n\n" + (err.stack || err.message || String(err))
    );
    throw err;
  }
}

/**
 * Fetches this keyword's qualifying RSS items and resolves each to its real
 * publisher URL. No article-text scraping and no LLM call - just title,
 * source, publish date, and a working link.
 */
function fetchDigestItems(keyword, maxItems) {
  const xml = fetchFeedXml(keyword);
  const rawItems = parseFeedItems(xml, maxItems);
  return rawItems.map(function (raw) {
    const realUrl = resolveRealUrl(raw.link);
    return {
      title: raw.title,
      source: raw.source,
      pubDate: raw.pubDate,
      url: realUrl || raw.link,
    };
  });
}

function fetchFeedXml(keyword) {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(keyword) +
    "&hl=en-US&gl=US&ceid=US:en";
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  return resp.getContentText();
}

function parseFeedItems(xmlText, maxItems) {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  cutoff.setUTCHours(0, 0, 0, 0);

  const document = XmlService.parse(xmlText);
  const channel = document.getRootElement().getChild("channel");
  const itemElements = channel.getChildren("item");

  const items = [];
  for (var i = 0; i < itemElements.length && items.length < maxItems; i++) {
    const el = itemElements[i];
    const title = (el.getChildText("title") || "").trim();
    const link = (el.getChildText("link") || "").trim();
    const pubDateStr = (el.getChildText("pubDate") || "").trim();
    const sourceEl = el.getChild("source");
    const source = sourceEl ? sourceEl.getText().trim() : "";

    const pubDate = new Date(pubDateStr);
    if (isNaN(pubDate.getTime())) continue;
    if (pubDate < cutoff || pubDate > now) continue;

    items.push({ title: title, link: link, pubDate: pubDateStr, source: source });
  }
  return items;
}

/**
 * Google News wraps article links behind a client-side (JS) redirect, so a
 * plain HTTP fetch never gets a Location header to the real article. The
 * redirect page embeds a signature + timestamp that can be used to resolve
 * the real URL via Google's internal batchexecute RPC - this replicates that
 * call so it works from a headless script (no browser).
 */
function resolveRealUrl(googleNewsUrl) {
  try {
    const artId = googleNewsUrl.split("/articles/")[1].split("?")[0];
    const htmlResp = UrlFetchApp.fetch(googleNewsUrl, {
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = htmlResp.getContentText();

    const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);
    if (!sigMatch || !tsMatch) return null;
    const sig = sigMatch[1];
    const ts = tsMatch[1];

    const inner = JSON.stringify([
      "garturlreq",
      [
        ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
        "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
      ],
      artId, ts, sig,
    ]);
    const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
    const body = "f.req=" + encodeURIComponent(freq);

    const resp = UrlFetchApp.fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "post",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      payload: body,
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const respText = resp.getContentText();
    const match = respText.match(/garturlres\\?",\\?"(https?:\/\/[^"\\]+)/);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

// ---- Persistent article history (Sheet, auto-created on first run) ----

function getSheetId_() {
  const props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("SHEET_ID");
  if (sheetId) return sheetId;

  const ss = SpreadsheetApp.create("mini-feedly Data");
  const sheet = ss.insertSheet(SHEET_NAMES.ARTICLES);
  sheet.appendRow(ARTICLE_HEADERS);
  sheet.setFrozenRows(1);

  const defaultSheet = ss.getSheetByName("Sheet1");
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  props.setProperty("SHEET_ID", ss.getId());
  Logger.log("mini-feedly Sheet created: " + ss.getUrl());
  return ss.getId();
}

function getArticlesSheet_() {
  const ss = SpreadsheetApp.openById(getSheetId_());
  var sheet = ss.getSheetByName(SHEET_NAMES.ARTICLES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.ARTICLES);
    sheet.appendRow(ARTICLE_HEADERS);
    sheet.setFrozenRows(1);
  }
  ensureSummaryColumn_(sheet);
  return sheet;
}

/**
 * Adds the Summary column to sheets created before summarization existed.
 * No-op once the column is already there.
 */
function ensureSummaryColumn_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (headers.indexOf("Summary") === -1) {
    sheet.getRange(1, headers.length + 1).setValue("Summary");
  }
}

/**
 * Appends only the articles not already stored for this keyword, deduped by
 * URL. Google News frequently re-surfaces the same story across days, so
 * without this the Sheet (and the web app's history) would fill up with
 * repeats of the same article.
 */
function appendNewArticles_(keyword, items) {
  const sheet = getArticlesSheet_();
  const data = sheet.getDataRange().getValues();
  const existingUrls = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === keyword) existingUrls[data[i][4]] = true;
  }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  items.forEach(function (it) {
    if (existingUrls[it.url]) return;
    sheet.appendRow([keyword, it.title, it.source, it.pubDate, it.url, today]);
    existingUrls[it.url] = true;
  });
}

/**
 * Best-effort plain-text extraction from an article's real publisher URL.
 * News sites vary wildly (paywalls, JS-rendered content, anti-bot blocks),
 * so this has no guarantee of success - it prefers an <article> tag if
 * present, strips script/style/nav/footer and all remaining markup, and
 * treats anything left under MIN_EXTRACTED_TEXT_LENGTH as a failed
 * extraction (usually a paywall or block page, not real article text).
 * Returns null on any failure so the caller can fall back cleanly.
 */
function extractArticleText_(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    });
    if (resp.getResponseCode() !== 200) return null;
    const html = resp.getContentText();

    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const fragment = articleMatch ? articleMatch[1] : html;

    const text = fragment
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    if (text.length < MIN_EXTRACTED_TEXT_LENGTH) return null;
    return text.slice(0, MAX_EXTRACTED_TEXT_LENGTH);
  } catch (err) {
    return null;
  }
}

/**
 * Summarizes article text via NVIDIA's Nemotron 3 Ultra API. Returns null
 * (not a throw) on any API failure so a single bad article can't abort the
 * whole batch in summarizeArticles().
 */
function summarizeWithNemotron_(articleText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("NVIDIA_API_KEY");
  if (!apiKey) throw new Error("NVIDIA_API_KEY Script Property is not set - see setup step 8 in the file header.");

  const payload = {
    model: NVIDIA_MODEL,
    messages: [
      { role: "system", content: "Summarize the given news article in 2-3 concise sentences. Return only the summary, no preamble or headings." },
      { role: "user", content: articleText },
    ],
    temperature: 0.3,
    max_tokens: 200,
  };

  const resp = UrlFetchApp.fetch(NVIDIA_API_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log("NVIDIA API error %s: %s", resp.getResponseCode(), resp.getContentText());
    return null;
  }

  const data = JSON.parse(resp.getContentText());
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return content ? content.trim() : null;
}

/**
 * Run this manually whenever you want summaries backfilled. Walks every
 * Sheet row still missing a Summary (oldest first), extracts article text,
 * and either gets a Nemotron summary or falls back to
 * SUMMARY_NOT_AVAILABLE - writing each result immediately so progress isn't
 * lost if the run is interrupted. Only rows that actually reach the NVIDIA
 * API are throttled (NVIDIA_RATE_LIMIT_DELAY_MS); extraction failures skip
 * the delay since they never touch the rate limit. Capped at
 * MAX_SUMMARIES_PER_RUN per run to stay well within Apps Script's execution
 * time limit - just run it again to pick up where it left off.
 */
function summarizeArticles() {
  const sheet = getArticlesSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const urlIdx = headers.indexOf("Url");
  const summaryIdx = headers.indexOf("Summary");

  var processed = 0;
  for (var i = 1; i < data.length && processed < MAX_SUMMARIES_PER_RUN; i++) {
    if (data[i][summaryIdx]) continue; // already summarized or already marked unavailable

    const rowNum = i + 1; // 1-indexed sheet row
    const url = data[i][urlIdx];
    const articleText = extractArticleText_(url);

    var summary;
    if (!articleText) {
      summary = SUMMARY_NOT_AVAILABLE;
    } else {
      summary = summarizeWithNemotron_(articleText) || SUMMARY_NOT_AVAILABLE;
      Utilities.sleep(NVIDIA_RATE_LIMIT_DELAY_MS);
    }

    sheet.getRange(rowNum, summaryIdx + 1).setValue(summary);
    processed++;
  }

  Logger.log("summarizeArticles: processed %s row(s).", processed);
}

// ---- Web app: Feedly-like per-keyword history ----

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("mini-feedly")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Returns the tracked keyword list plus each keyword's total article count,
 * for the sidebar. Cheap compared to getArticlesPage_ since it never builds
 * per-article objects.
 */
function getKeywordCounts() {
  const sheet = getArticlesSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const kwIdx = headers.indexOf("Keyword");

  const counts = {};
  KEYWORDS.forEach(function (k) { counts[k] = 0; });
  data.forEach(function (row) {
    const kw = row[kwIdx];
    counts[kw] = (counts[kw] || 0) + 1;
  });

  return JSON.parse(JSON.stringify({ keywords: KEYWORDS, counts: counts }));
}

/**
 * Returns one page of a single keyword's article history, newest first.
 * `offset` is how many newest-first articles to skip (0 for the first
 * page), `limit` is how many to return after that (PAGE_SIZE from the
 * client). `hasMore` tells the client whether to show another "See More".
 */
function getArticlesPage(keyword, offset, limit) {
  const sheet = getArticlesSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const kwIdx = headers.indexOf("Keyword");
  const titleIdx = headers.indexOf("Title");
  const sourceIdx = headers.indexOf("Source");
  const pubIdx = headers.indexOf("PubDate");
  const urlIdx = headers.indexOf("Url");
  const seenIdx = headers.indexOf("FirstSeenDate");
  const summaryIdx = headers.indexOf("Summary");

  const matches = data.filter(function (row) { return row[kwIdx] === keyword; });
  matches.reverse(); // rows are appended oldest -> newest; newest first for display

  const page = matches.slice(offset, offset + limit).map(function (row) {
    return {
      title: row[titleIdx],
      source: row[sourceIdx],
      pubDate: row[pubIdx],
      url: row[urlIdx],
      firstSeen: row[seenIdx],
      summary: row[summaryIdx] || "",
    };
  });

  return JSON.parse(JSON.stringify({
    items: page,
    hasMore: offset + limit < matches.length,
  }));
}

// ---- Email composition (plain title + URL, no summary) ----

function composeDigestEmail(keywordResults) {
  var lines = ["mini-feedly Daily Digest", ""];
  keywordResults.forEach(function (r) {
    lines.push("== " + r.keyword + " ==");
    if (r.items.length === 0) {
      lines.push("No qualifying articles found in the previous-day-to-today window.");
    } else {
      r.items.forEach(function (it, idx) {
        lines.push((idx + 1) + ". " + it.title);
        lines.push(it.url);
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayUrl(url) {
  return escapeHtml(url.replace(/^https?:\/\//, ""));
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function composeDigestEmailHtml(keywordResults) {
  const nowIst = Utilities.formatDate(new Date(), "Asia/Calcutta", "yyyy-MM-dd · HH:mm 'IST'");

  const sectionsHtml = keywordResults
    .map(function (r) {
      var cardsHtml;
      if (r.items.length === 0) {
        cardsHtml =
          '<tr><td style="padding:6px 32px 0 32px; font-family:-apple-system,Helvetica,Arial,sans-serif; color:#8b949e; font-size:13px;">' +
          "No qualifying articles found in the previous-day-to-today window." +
          "</td></tr>";
      } else {
        cardsHtml = r.items
          .map(function (it, idx) {
            return (
              '<tr><td style="padding:' + (idx === 0 ? "6px" : "12px") + ' 32px 0 32px;">' +
              '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111820; border-left:3px solid #3fb950; border-radius:6px;">' +
              '<tr><td style="padding:14px 18px;">' +
              '<div style="font-family:\'Courier New\',Consolas,monospace; font-size:11px; color:#3fb950; letter-spacing:1px;">' +
              pad2(idx + 1) + " &nbsp;·&nbsp; " + escapeHtml((it.source || "UNKNOWN SOURCE").toUpperCase()) +
              "</div>" +
              '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:16px; font-weight:700; color:#f0f6fc; margin-top:6px; line-height:1.4;">' +
              escapeHtml(it.title) +
              "</div>" +
              '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:13px; color:#8b949e; margin-top:8px; line-height:1.6;">' +
              '<a href="' + escapeHtml(it.url) + '" style="color:#58a6ff; text-decoration:none;">' + displayUrl(it.url) + "</a>" +
              "</div>" +
              "</td></tr></table></td></tr>"
            );
          })
          .join("");
      }

      return (
        '<tr><td style="padding:22px 32px 0 32px;">' +
        '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:15px; font-weight:700; color:#58a6ff; text-transform:uppercase; letter-spacing:0.5px;">' +
        escapeHtml(r.keyword) + " &nbsp;·&nbsp; <span style=\"color:#8b949e; font-weight:400; text-transform:none;\">" + r.items.length + " articles</span>" +
        "</div></td></tr>" +
        cardsHtml
      );
    })
    .join("");

  return (
    '<!doctype html><html><body style="margin:0; padding:0; background:#05070a;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05070a; padding:32px 16px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px; max-width:100%; background:#0d1117; border:1px solid #1f2732; border-radius:12px; overflow:hidden;">' +
    '<tr><td style="padding:28px 32px 12px 32px; border-bottom:1px solid #1f2732;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-family:\'Courier New\',Consolas,monospace; font-size:12px; letter-spacing:3px; color:#3fb950; text-transform:uppercase;">● mini-feedly // LIVE FEED</td>' +
    '<td align="right" style="font-family:\'Courier New\',Consolas,monospace; font-size:12px; color:#5b6472;">' + nowIst + "</td>" +
    "</tr></table>" +
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:22px; font-weight:700; color:#e6edf3; margin-top:10px;">Daily Digest</div>' +
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:13px; color:#8b949e; margin-top:4px;">' +
    keywordResults.length + " keyword(s) tracked &nbsp;·&nbsp; window: previous day → today" +
    "</div>" +
    "</td></tr>" +
    sectionsHtml +
    '<tr><td style="padding:28px 32px 28px 32px;">' +
    '<div style="border-top:1px solid #1f2732; margin-top:16px; padding-top:16px; font-family:\'Courier New\',Consolas,monospace; font-size:11px; color:#4b535e; text-align:center;">' +
    "mini-feedly &nbsp;·&nbsp; generated by Google Apps Script" +
    "</div></td></tr>" +
    "</table></td></tr></table></body></html>"
  );
}
