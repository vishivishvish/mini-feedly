#!/usr/bin/env python3
"""Fetch the miniFeedly digest: Google News RSS for a keyword, printed as plain text.

Usage: python3 fetch_digest.py ["Artificial Intelligence"] [max_items]
"""
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import quote

DEFAULT_KEYWORD = "Artificial Intelligence"
DEFAULT_MAX_ITEMS = 15


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


def parse_items(xml_bytes: bytes, max_items: int):
    root = ET.fromstring(xml_bytes)
    items = []
    for item in root.findall(".//item")[:max_items]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        source = item.find("source")
        source_name = source.text.strip() if source is not None and source.text else ""
        items.append({"title": title, "link": link, "pubDate": pub_date, "source": source_name})
    return items


def render_digest(keyword: str, items) -> str:
    lines = [f"miniFeedly Digest: {keyword}", ""]
    if not items:
        lines.append("No items found.")
    for i, it in enumerate(items, 1):
        src = f" ({it['source']})" if it["source"] else ""
        lines.append(f"{i}. {it['title']}{src}")
        lines.append(f"   {it['link']}")
        if it["pubDate"]:
            lines.append(f"   {it['pubDate']}")
        lines.append("")
    return "\n".join(lines)


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_KEYWORD
    max_items = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_MAX_ITEMS
    xml_bytes = fetch_feed(keyword)
    items = parse_items(xml_bytes, max_items)
    print(render_digest(keyword, items))


if __name__ == "__main__":
    main()
