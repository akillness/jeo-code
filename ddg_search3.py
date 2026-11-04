from duckduckgo_search import DDGS
import json

with DDGS() as ddgs:
    results = [r for r in ddgs.text('site:wanted.co.kr "AI Agent"', max_results=10)]
    print(json.dumps(results, ensure_ascii=False, indent=2))
