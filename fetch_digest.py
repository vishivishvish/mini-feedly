#!/usr/bin/env python3
"""Fetch the miniFeedly digest: Google News RSS for a keyword, printed as plain text.

Usage: python3 fetch_digest.py ["Artificial Intelligence"] [max_items]
"""
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from urllib.parse import quote

DEFAULT_KEYWORD = "Artificial Intelligence"
DEFAULT_MAX_ITEMS = 10
RUNS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Runs")
ARTICLE_TEXT_CHARS = 4000


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def fetch_feed(keyword: str) -> str:
    url = f"https://news.google.com/rss/search?q={quote(keyword)}&hl=en-US&gl=US&ceid=US:en"
    req = urllib.request.Request(url, headers={"User-Agent": "miniFeedly/1.0"})
    with urllib.request.urlopen(req, timeout=20, context=_ssl_context()) as resp:
        return resp.read()


def _http(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    with urllib.request.urlopen(req, timeout=20, context=_ssl_context()) as resp:
        return resp.read().decode("utf-8", errors="replace")


def resolve_real_url(google_news_url: str):
    """Decode a Google News RSS redirect link to the real publisher URL.

    Google News wraps article links behind a client-side (JS) redirect, so a
    plain HTTP client never sees a Location header to the real article. The
    page does embed a signature + timestamp used to resolve the real URL via
    Google's internal batchexecute RPC - this replicates that call so it works
    from a headless script (no browser) in a cloud sandbox.
    """
    art_id = google_news_url.rstrip("/").split("/articles/")[-1].split("?")[0]
    try:
        html = _http(google_news_url, headers={"User-Agent": "Mozilla/5.0"})
        sig = re.search(r'data-n-a-sg="([^"]+)"', html).group(1)
        ts = re.search(r'data-n-a-ts="([^"]+)"', html).group(1)

        inner = json.dumps([
            "garturlreq",
            [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1,
              None, None, None, None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
            art_id, ts, sig,
        ])
        freq = json.dumps([[["Fbv4je", inner, None, "generic"]]])
        body = ("f.req=" + urllib.parse.quote(freq)).encode()
        resp = _http(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            data=body,
            headers={
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                "User-Agent": "Mozilla/5.0",
            },
            method="POST",
        )
        match = re.search(r'garturlres\\?",\\?"(https?://[^"\\]+)', resp)
        return match.group(1) if match else None
    except Exception:
        return None


class _TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "nav", "header", "footer", "noscript", "svg", "form"}

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self.chunks = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            text = data.strip()
            if text:
                self.chunks.append(text)


def fetch_article_text(url: str, max_chars: int = ARTICLE_TEXT_CHARS):
    try:
        html = _http(url, headers={"User-Agent": "Mozilla/5.0"})
        parser = _TextExtractor()
        parser.feed(html)
        text = " ".join(parser.chunks)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:max_chars] if text else None
    except Exception:
        return None


def parse_items(xml_bytes: bytes, max_items: int):
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)

    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.findall(".//item"):
        if len(items) >= max_items:
            break
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        source = item.find("source")
        source_name = source.text.strip() if source is not None and source.text else ""

        try:
            pub_dt = parsedate_to_datetime(pub_date)
            if pub_dt.tzinfo is None:
                pub_dt = pub_dt.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue

        # Only keep articles from the previous day through today (UTC) - never older.
        if pub_dt < cutoff or pub_dt > now:
            continue

        real_url = resolve_real_url(link) if link else None
        article_text = fetch_article_text(real_url) if real_url else None

        items.append({
            "title": title,
            "link": link,
            "real_url": real_url,
            "pubDate": pub_date,
            "source": source_name,
            "article_text": article_text,
        })
    return items


def render_digest(keyword: str, items) -> str:
    lines = [f"miniFeedly Digest: {keyword}", ""]
    if not items:
        lines.append("No items found.")
    for i, it in enumerate(items, 1):
        src = f" ({it['source']})" if it["source"] else ""
        lines.append(f"{i}. {it['title']}{src}")
        lines.append(f"   {it['real_url'] or it['link']}")
        if it["pubDate"]:
            lines.append(f"   {it['pubDate']}")
        lines.append(f"   [article text {'available' if it['article_text'] else 'NOT available - write no fabricated description'}]")
        lines.append("")
    return "\n".join(lines)


def save_run(keyword: str, items) -> str:
    os.makedirs(RUNS_DIR, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(RUNS_DIR, f"run_{timestamp}.xml")
    payload = {
        "keyword": keyword,
        "fetched_at": timestamp,
        "item_count": len(items),
        "items": items,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    return path


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_KEYWORD
    max_items = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_ITEMS
    xml_bytes = fetch_feed(keyword)
    items = parse_items(xml_bytes, max_items)
    saved_path = save_run(keyword, items)
    print(render_digest(keyword, items))
    print(f"\nSaved run to {saved_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
