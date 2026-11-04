import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

def fetch_rss(query, gl='US', hl='en-US'):
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl={hl}&gl={gl}&ceid={gl}:{hl}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        html = urllib.request.urlopen(req).read()
        root = ET.fromstring(html)
        items = root.findall('.//item')
        results = []
        for item in items[:15]:
            title = item.find('title').text
            pubDate = item.find('pubDate').text
            results.append({'title': title, 'date': pubDate})
        return results
    except Exception as e:
        return str(e)

print("--- KR News ---")
kr_news = fetch_rss('AI 게임 when:7d', 'KR', 'ko')
for i, n in enumerate(kr_news):
    print(f"{i}: {n['title']}")

print("--- Global News ---")
us_news = fetch_rss('"video game" OR "video games" AI when:7d', 'US', 'en')
for i, n in enumerate(us_news):
    print(f"{i}: {n['title']}")
