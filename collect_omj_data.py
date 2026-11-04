import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import json
import datetime
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch_rss(query, hl, gl, ceid):
    url = f"https://news.google.com/rss/search?q={urllib.parse.quote(query)}+when:7d&hl={hl}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            xml_data = response.read()
        root = ET.fromstring(xml_data)
        items = root.findall('.//item')[:5]
        results = []
        for item in items:
            title = item.find('title').text if item.find('title') is not None else 'No Title'
            link = item.find('link').text if item.find('link') is not None else 'No Link'
            pubdate = item.find('pubDate').text if item.find('pubDate') is not None else ''
            results.append({'title': title, 'link': link, 'date': pubdate})
        return results
    except Exception as e:
        return str(e)

print("--- KR NEWS ---")
kr_news = fetch_rss("AI 게임", "ko", "KR", "KR:ko")
for n in kr_news:
    print(f"- {n['title']} \n  {n['link']}")

print("\n--- EN NEWS ---")
en_news = fetch_rss("AI Game", "en-US", "US", "US:en")
for n in en_news:
    print(f"- {n['title']} \n  {n['link']}")

print("\n--- GITHUB TRENDING ---")
# 7 days ago from 2026-07-15 is 2026-07-08
date_str = "2026-07-08"
gh_url = f"https://api.github.com/search/repositories?q=AI+pushed:>{date_str}&sort=stars&order=desc"
gh_req = urllib.request.Request(gh_url, headers={'User-Agent': 'Mozilla/5.0'})
try:
    with urllib.request.urlopen(gh_req, context=ctx) as response:
        gh_data = json.loads(response.read().decode('utf-8'))
    for repo in gh_data.get('items', [])[:10]:
        print(f"- {repo['name']} ({repo['stargazers_count']} stars): {repo['description']}\n  {repo['html_url']}")
except Exception as e:
    print(f"Error: {e}")

