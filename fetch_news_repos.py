import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import json
import datetime

# Get dates
today = datetime.date(2026, 7, 11)
last_week = today - datetime.timedelta(days=7)
last_week_str = last_week.strftime("%Y-%m-%d")

# Fetch GitHub Repos
github_url = f"https://api.github.com/search/repositories?q=topic:ai+created:>{last_week_str}&sort=stars&order=desc"
req = urllib.request.Request(github_url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req) as response:
        repos_data = json.loads(response.read().decode())
        repos = repos_data.get('items', [])[:10]
        print("=== GITHUB AI REPOS ===")
        for r in repos:
            print(f"{r['name']} | {r['html_url']} | {r['description']} | Stars: {r['stargazers_count']}")
except Exception as e:
    print(f"Error fetching github: {e}")

# Fetch News function
def fetch_news(query, hl, gl, ceid, limit=5):
    q = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
            root = ET.fromstring(xml_data)
            items = root.findall('.//item')[:limit]
            for item in items:
                title = item.find('title').text
                link = item.find('link').text
                pubDate = item.find('pubDate').text
                print(f"{title} | {link} | {pubDate}")
    except Exception as e:
        print(f"Error fetching news: {e}")

print("\n=== DOMESTIC NEWS ===")
fetch_news("AI OR 게임 when:1d", "ko", "KR", "KR:ko", 5)

print("\n=== OVERSEAS NEWS ===")
fetch_news("AI OR Game when:1d", "en-US", "US", "US:en", 5)

