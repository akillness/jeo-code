import urllib.request
import urllib.parse
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

def get_news(query, hl, gl, ceid):
    encoded_query = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={encoded_query}&hl={hl}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
        root = ET.fromstring(xml_data)
        items = []
        for item in root.findall('./channel/item')[:10]: # Fetch more in case of duplicates
            items.append({
                'title': item.find('title').text,
                'link': item.find('link').text,
                'pubDate': item.find('pubDate').text
            })
        return items
    except Exception as e:
        return str(e)

def get_github_repos():
    # Last 7 days
    date_7_days_ago = (datetime.now() - timedelta(days=14)).strftime('%Y-%m-%d')
    # Query AI repos created recently, sorted by stars
    url = f"https://api.github.com/search/repositories?q=topic:ai+created:>{date_7_days_ago}&sort=stars&order=desc"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
        repos = []
        for item in data.get('items', [])[:15]:
            repos.append({
                'name': item['full_name'],
                'url': item['html_url'],
                'description': item['description'],
                'stars': item['stargazers_count']
            })
        return repos
    except Exception as e:
        return str(e)

print("--- DOMESTIC NEWS ---")
kr_news = get_news("AI 게임 when:7d", "ko", "KR", "KR:ko")
for n in kr_news[:5]: print(f"- {n['title']}\n  {n['link']}")

print("\n--- OVERSEAS NEWS ---")
en_news = get_news("AI Game when:7d", "en-US", "US", "US:en")
for n in en_news[:5]: print(f"- {n['title']}\n  {n['link']}")

print("\n--- GITHUB REPOS ---")
repos = get_github_repos()
for r in repos[:10]: print(f"- {r['name']} ({r['stars']} stars): {r['description']}\n  {r['url']}")
