import json
import requests
from duckduckgo_search import DDGS
from datetime import datetime, timedelta

results = {"kr_news": [], "en_news": [], "repos": []}
try:
    with DDGS() as ddgs:
        kr = list(ddgs.news("AI 게임", region="kr-kr", safesearch="off", timelimit="w", max_results=5))
        results["kr_news"] = [{"title": r['title'], "url": r['url'], "body": r.get('body', '')} for r in kr]
except Exception as e:
    results["kr_news_error"] = str(e)

try:
    with DDGS() as ddgs:
        en = list(ddgs.news("AI game", region="wt-wt", safesearch="off", timelimit="w", max_results=5))
        results["en_news"] = [{"title": r['title'], "url": r['url'], "body": r.get('body', '')} for r in en]
except Exception as e:
    results["en_news_error"] = str(e)

try:
    date_since = (datetime(2026, 7, 13) - timedelta(days=7)).strftime('%Y-%m-%d')
    url = f"https://api.github.com/search/repositories?q=AI+created:>{date_since}&sort=stars&order=desc"
    headers = {"Accept": "application/vnd.github.v3+json", "User-Agent": "Mozilla/5.0"}
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        data = response.json()
        for item in data.get('items', [])[:10]:
            results["repos"].append({
                "name": item['full_name'],
                "url": item['html_url'],
                "description": item['description'],
                "stars": item['stargazers_count']
            })
    else:
        results["repos_error"] = f"HTTP {response.status_code}: {response.text}"
except Exception as e:
    results["repos_error"] = str(e)

with open('results.json', 'w', encoding='utf-8') as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print("Done")
