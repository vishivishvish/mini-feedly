# miniFeedly

Minimal, always-on news digest pipeline.

`fetch_digest.py` pulls the Google News RSS feed for a keyword and prints a
plain-text digest (title, source, link, published date per item).

## Usage

```bash
python3 fetch_digest.py "Artificial Intelligence" 15
```

Args: keyword (default "Artificial Intelligence"), max items (default 15).

## Cloud routine

A scheduled cloud agent runs this script daily and emails the digest via
the Gmail MCP connector. Add more feeds/keywords by running the script
multiple times with different keywords and concatenating the output.
