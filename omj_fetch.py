import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import json
import datetime

def get_news(query, hl, gl, ceid, num=5):
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}&hl={hl}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
        root = ET.fromstring(xml_data)
        items = root.findall('.//item')[:num]
        res = []
        for item in items:
            title = item.find('title').text
            link = item.find('link').text
            pubDate = item.find('pubDate').text
            res.append({'title': title, 'link': link, 'pubDate': pubDate})
        return res
    except Exception as e:
        return f"Error: {e}"

last_week = (datetime.datetime.utcnow() - datetime.timedelta(days=7)).strftime('%Y-%m-%d')

def get_github_trending(limit=10):
    url = f"https://api.github.com/search/repositories?q=topic:ai+created:>{last_week}&sort=stars&order=desc"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
        res = []
        for item in data.get('items', [])[:limit]:
            res.append({
                'title': item['full_name'],
                'link': item['html_url'],
                'desc': item['description']
            })
        return res
    except Exception as e:
        return f"Error: {e}"

print("--- DOMESTIC NEWS ---")
for d in get_news("AI 게임 when:7d", "ko", "KR", "KR:ko", 5):
    print(d)

print("--- OVERSEAS NEWS ---")
for o in get_news("AI Game when:7d", "en", "US", "US:en", 5):
    print(o)

print("--- GITHUB OPEN SOURCE ---")
for g in get_github_trending(10):
    print(g)

