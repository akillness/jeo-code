import urllib.request
import xml.etree.ElementTree as ET
import json
import datetime

# 1. GitHub API
# 7 days ago from 2026-07-15 is 2026-07-08
url_gh = "https://api.github.com/search/repositories?q=topic:ai+pushed:>2026-07-08&sort=stars&order=desc&per_page=15"
req_gh = urllib.request.Request(url_gh, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req_gh) as response:
        gh_data = json.loads(response.read().decode())
        print("=== GITHUB AI TRENDING ===")
        for item in gh_data.get('items', [])[:10]:
            print(f"- {item['name']}: {item['html_url']} (Stars: {item['stargazers_count']}) - {item['description']}")
except Exception as e:
    print("GitHub API error:", e)

# 2. Google News - Domestic (AI + 게임)
url_kr = "https://news.google.com/rss/search?q=AI+%EA%B2%8C%EC%9E%84+when:7d&hl=ko&gl=KR&ceid=KR:ko"
req_kr = urllib.request.Request(url_kr, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req_kr) as response:
        tree = ET.fromstring(response.read())
        print("\n=== DOMESTIC NEWS ===")
        count = 0
        for item in tree.findall('.//item'):
            if count >= 5: break
            title = item.find('title').text
            link = item.find('link').text
            pubDate = item.find('pubDate').text
            print(f"- {title}\n  {link}\n  {pubDate}")
            count += 1
except Exception as e:
    print("News KR error:", e)

# 3. Google News - International (AI + Gaming)
url_en = "https://news.google.com/rss/search?q=AI+Gaming+when:7d&hl=en-US&gl=US&ceid=US:en"
req_en = urllib.request.Request(url_en, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(req_en) as response:
        tree = ET.fromstring(response.read())
        print("\n=== INTERNATIONAL NEWS ===")
        count = 0
        for item in tree.findall('.//item'):
            if count >= 5: break
            title = item.find('title').text
            link = item.find('link').text
            pubDate = item.find('pubDate').text
            print(f"- {title}\n  {link}\n  {pubDate}")
            count += 1
except Exception as e:
    print("News EN error:", e)
