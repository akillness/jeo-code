import urllib.request
import xml.etree.ElementTree as ET
import json
import datetime

# Fetch Korean News
url_ko = "https://news.google.com/rss/search?q=AI+OR+%EA%B2%8C%EC%9E%84+when:1d&hl=ko&gl=KR&ceid=KR:ko"
req = urllib.request.Request(url_ko, headers={'User-Agent': 'Mozilla/5.0'})
xml_ko = urllib.request.urlopen(req).read()
root_ko = ET.fromstring(xml_ko)
items_ko = root_ko.findall('.//item')[:5]

ko_news = []
for item in items_ko:
    ko_news.append({
        'title': item.find('title').text,
        'link': item.find('link').text,
        'pubDate': item.find('pubDate').text
    })

# Fetch Global News
url_en = "https://news.google.com/rss/search?q=AI+OR+Game+when:1d&hl=en-US&gl=US&ceid=US:en"
req = urllib.request.Request(url_en, headers={'User-Agent': 'Mozilla/5.0'})
xml_en = urllib.request.urlopen(req).read()
root_en = ET.fromstring(xml_en)
items_en = root_en.findall('.//item')[:5]

en_news = []
for item in items_en:
    en_news.append({
        'title': item.find('title').text,
        'link': item.find('link').text,
        'pubDate': item.find('pubDate').text
    })

# Fetch Github Trending
last_week = (datetime.datetime.now() - datetime.timedelta(days=7)).strftime('%Y-%m-%d')
url_gh = f"https://api.github.com/search/repositories?q=topic:ai+created:>{last_week}&sort=stars&order=desc"
req = urllib.request.Request(url_gh, headers={'User-Agent': 'Mozilla/5.0'})
try:
    resp = urllib.request.urlopen(req).read()
    gh_data = json.loads(resp)
    gh_repos = gh_data.get('items', [])[:10]
except Exception as e:
    gh_repos = []

repos = []
for r in gh_repos:
    repos.append({
        'name': r['full_name'],
        'description': r['description'],
        'url': r['html_url'],
        'stars': r['stargazers_count']
    })

data = {
    'ko_news': ko_news,
    'en_news': en_news,
    'github': repos
}

print(json.dumps(data, ensure_ascii=False, indent=2))
