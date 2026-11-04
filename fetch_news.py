import urllib.request
import xml.etree.ElementTree as ET
import json
import datetime
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch_rss(url, limit=5):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        html = urllib.request.urlopen(req, context=ctx).read()
        root = ET.fromstring(html)
        items = root.findall('./channel/item')
        results = []
        for item in items[:limit]:
            title = item.find('title').text
            link = item.find('link').text
            pubDate = item.find('pubDate').text
            results.append({'title': title, 'link': link, 'pubDate': pubDate})
        return results
    except Exception as e:
        return str(e)

print("--- Domestic News ---")
kr_url = 'https://news.google.com/rss/search?q=AI+%EA%B2%8C%EC%9E%84+when:7d&hl=ko&gl=KR&ceid=KR:ko'
for r in fetch_rss(kr_url, 15):
    print(r)

print("\n--- International News ---")
en_url = 'https://news.google.com/rss/search?q=AI+Gaming+OR+Game+when:7d&hl=en-US&gl=US&ceid=US:en'
for r in fetch_rss(en_url, 15):
    print(r)

print("\n--- GitHub Trending AI Repos ---")
one_week_ago = (datetime.datetime.now() - datetime.timedelta(days=7)).strftime('%Y-%m-%d')
gh_url = f'https://api.github.com/search/repositories?q=topic:ai+pushed:>{one_week_ago}&sort=stars&order=desc'
req = urllib.request.Request(gh_url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    response = urllib.request.urlopen(req, context=ctx).read()
    data = json.loads(response)
    for item in data.get('items', [])[:10]:
        print(f"[{item['name']}]({item['html_url']}) - {item['description']}")
except Exception as e:
    print("GH Error:", e)

