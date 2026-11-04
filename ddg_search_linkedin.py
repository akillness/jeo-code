from duckduckgo_search import DDGS
import json

with DDGS() as ddgs:
    results = [r for r in ddgs.text('site:kr.linkedin.com/jobs/view "AI Agent" OR "AI Native"', max_results=20)]
    print(json.dumps(results, ensure_ascii=False, indent=2))
