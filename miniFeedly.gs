/**
 * miniFeedly - Google Apps Script version
 *
 * Daily AI news digest: fetches Google News RSS for a keyword, keeps only
 * articles from the previous day through today, resolves each Google News
 * redirect link to the real publisher URL, fetches the article text, pulls
 * the first few sentences of it verbatim (no LLM call), and emails you the
 * digest.
 *
 * SETUP (one-time):
 * 1. Run `runDailyDigest` once manually to authorize permissions
 *    (external requests + send email).
 * 2. Set project timezone to Asia/Calcutta (Project Settings) so a "9am"
 *    trigger means 9am IST.
 * 3. Triggers (clock icon) > Add Trigger > function: runDailyDigest,
 *    Time-driven, Day timer, 9am - 10am.
 */

const KEYWORD = "Artificial Intelligence";
const MAX_ITEMS = 10;
const RECIPIENT_EMAIL = "vishnu.subramanian1@mygreatlearning.com";
const ARTICLE_TEXT_CHARS = 4000;
const FIRST_PARAGRAPH_SENTENCES = 3;

function runDailyDigest() {
  try {
    const items = fetchDigestItems(KEYWORD, MAX_ITEMS);
    const textBody = composeDigestEmail(KEYWORD, items);
    const htmlBody = composeDigestEmailHtml(KEYWORD, items);
    const subject = "miniFeedly Daily AI Digest - " + Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
    MailApp.sendEmail({
      to: RECIPIENT_EMAIL,
      subject: subject,
      body: textBody,
      htmlBody: htmlBody,
    });
    Logger.log("Digest sent with %s items.", items.length);
  } catch (err) {
    // Never fail silently - email the error so a broken run is still visible.
    MailApp.sendEmail(
      RECIPIENT_EMAIL,
      "miniFeedly Daily AI Digest - ERROR",
      "The daily digest run failed:\n\n" + (err.stack || err.message || String(err))
    );
    throw err;
  }
}

function fetchDigestItems(keyword, maxItems) {
  const xml = fetchFeedXml(keyword);
  const rawItems = parseFeedItems(xml, maxItems);

  return rawItems.map(function (raw) {
    const realUrl = resolveRealUrl(raw.link);
    const articleText = realUrl ? fetchArticleText(realUrl) : null;
    const firstParagraph = articleText
      ? extractFirstParagraph(articleText, FIRST_PARAGRAPH_SENTENCES)
      : "First paragraph not available (article text could not be fetched).";

    return {
      title: raw.title,
      source: raw.source,
      pubDate: raw.pubDate,
      url: realUrl || raw.link,
      firstParagraph: firstParagraph,
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

function fetchArticleText(url) {
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    var html = resp.getContentText();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
    html = html.replace(/<!--[\s\S]*?-->/g, " ");
    var text = html.replace(/<[^>]+>/g, " ");
    text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    text = text.replace(/\s+/g, " ").trim();
    return text ? text.substring(0, ARTICLE_TEXT_CHARS) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Pulls the first few sentences out of the flattened article text verbatim -
 * no LLM call. fetchArticleText() already stripped HTML and collapsed
 * whitespace into one continuous run of text, so paragraph breaks are gone;
 * splitting on sentence-ending punctuation is the closest available proxy
 * for "first paragraph."
 */
function extractFirstParagraph(articleText, maxSentences) {
  if (!articleText) return null;
  const sentences = articleText.match(/[^.!?]+[.!?]+(\s+|$)/g);
  if (!sentences || sentences.length === 0) {
    return articleText.substring(0, 400).trim();
  }
  const count = Math.min(maxSentences || 3, sentences.length);
  return sentences.slice(0, count).join("").trim();
}

function composeDigestEmail(keyword, items) {
  var lines = ["miniFeedly Daily Digest: " + keyword, ""];

  if (items.length === 0) {
    lines.push("No qualifying articles found in the previous-day-to-today window.");
  }
  items.forEach(function (it, idx) {
    lines.push((idx + 1) + ". " + it.title);
    lines.push("Source: " + it.url);
    lines.push("First Paragraph: " + it.firstParagraph);
    lines.push("");
  });
  return lines.join("\n");
}

// ---- HTML "command center" email (dark theme) ----

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

function composeDigestEmailHtml(keyword, items) {
  const nowIst = Utilities.formatDate(new Date(), "Asia/Calcutta", "yyyy-MM-dd · HH:mm 'IST'");

  var cardsHtml;
  if (items.length === 0) {
    cardsHtml =
      '<tr><td style="padding:24px 32px 0 32px; font-family:-apple-system,Helvetica,Arial,sans-serif; color:#8b949e;">' +
      "No qualifying articles found in the previous-day-to-today window." +
      "</td></tr>";
  } else {
    cardsHtml = items
      .map(function (it, idx) {
        return (
          '<tr><td style="padding:' + (idx === 0 ? "24px" : "16px") + ' 32px 0 32px;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111820; border-left:3px solid #3fb950; border-radius:6px;">' +
          '<tr><td style="padding:18px 20px;">' +
          '<div style="font-family:\'Courier New\',Consolas,monospace; font-size:11px; color:#3fb950; letter-spacing:1px;">' +
          pad2(idx + 1) + " &nbsp;·&nbsp; " + escapeHtml((it.source || "UNKNOWN SOURCE").toUpperCase()) +
          "</div>" +
          '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:17px; font-weight:700; color:#f0f6fc; margin-top:6px; line-height:1.4;">' +
          escapeHtml(it.title) +
          "</div>" +
          '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:13px; color:#8b949e; margin-top:10px; line-height:1.6;">' +
          '<span style="font-weight:700; color:#58a6ff;">Source:</span> ' +
          '<a href="' + escapeHtml(it.url) + '" style="color:#58a6ff; text-decoration:none;">' + displayUrl(it.url) + "</a>" +
          "</div>" +
          '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:14px; color:#c9d1d9; margin-top:8px; line-height:1.6;">' +
          '<span style="font-weight:700; color:#e6edf3;">First Paragraph:</span> ' + escapeHtml(it.firstParagraph) +
          "</div>" +
          "</td></tr></table></td></tr>"
        );
      })
      .join("");
  }

  return (
    '<!doctype html><html><body style="margin:0; padding:0; background:#05070a;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05070a; padding:32px 16px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px; max-width:100%; background:#0d1117; border:1px solid #1f2732; border-radius:12px; overflow:hidden;">' +
    '<tr><td style="padding:28px 32px 20px 32px; border-bottom:1px solid #1f2732;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="font-family:\'Courier New\',Consolas,monospace; font-size:12px; letter-spacing:3px; color:#3fb950; text-transform:uppercase;">● MINIFEEDLY // LIVE FEED</td>' +
    '<td align="right" style="font-family:\'Courier New\',Consolas,monospace; font-size:12px; color:#5b6472;">' + nowIst + "</td>" +
    "</tr></table>" +
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:22px; font-weight:700; color:#e6edf3; margin-top:10px;">Daily AI Digest</div>' +
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif; font-size:13px; color:#8b949e; margin-top:4px;">' +
    "Topic: <span style=\"color:#58a6ff;\">" + escapeHtml(keyword) + "</span> &nbsp;·&nbsp; " + items.length + " articles &nbsp;·&nbsp; window: previous day → today" +
    "</div>" +
    "</td></tr>" +
    cardsHtml +
    '<tr><td style="padding:28px 32px 28px 32px;">' +
    '<div style="border-top:1px solid #1f2732; padding-top:16px; font-family:\'Courier New\',Consolas,monospace; font-size:11px; color:#4b535e; text-align:center;">' +
    "miniFeedly &nbsp;·&nbsp; generated by Google Apps Script" +
    "</div></td></tr>" +
    "</table></td></tr></table></body></html>"
  );
}
