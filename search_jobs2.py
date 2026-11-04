import urllib.parse
from googlesearch import search
import time
import json
import requests
from bs4 import BeautifulSoup
import re

queries = [
    'site:wanted.co.kr/wd "AI Agent"',
    'site:wanted.co.kr/wd "AI Native"',
    'site:jumpit.co.kr/position "AI Agent"',
    'site:rocketpunch.com/jobs "AI Agent"'
]

results = []

for q in queries:
    try:
        # Get top 5 results for each query
        for url in search(q, num_results=5, lang='ko'):
            results.append({'url': url, 'query': q})
    except Exception as e:
        print(f"Error on {q}: {e}")
    time.sleep(1)

scraped = []

for item in results:
    url = item['url']
    if url in [x['url'] for x in scraped]:
        continue
    try:
        resp = requests.get(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}, timeout=5)
        soup = BeautifulSoup(resp.text, 'html.parser')
        
        # very basic extraction
        title = soup.title.text if soup.title else ''
        text = soup.get_text(separator=' ', strip=True)
        
        scraped.append({
            'url': url,
            'title': title,
            'text': text[:500] # just getting a snippet to extract company/role
        })
    except Exception as e:
        pass

print(json.dumps(scraped, ensure_ascii=False, indent=2))
