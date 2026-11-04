from duckduckgo_search import DDGS
import json

with DDGS() as ddgs:
    results = [r for r in ddgs.text('("AI Agent" OR "AI 에이전트" OR "AI Native" OR "AI 네이티브") 채용 (원티드 OR wanted OR 점핏 OR jumpit)', max_results=15)]
    print(json.dumps(results, ensure_ascii=False, indent=2))
