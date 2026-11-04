import feedparser
from urllib.parse import quote

def get_news(query, hl, gl):
    q = quote(query)
    url = f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={gl}:{hl}"
    feed = feedparser.parse(url)
    for entry in feed.entries[:5]:
        print("TITLE:", entry.title)
        print("URL:", entry.link)
        print("---")

print("=== EN NEWS ===")
get_news("AI gaming", "en-US", "US")
