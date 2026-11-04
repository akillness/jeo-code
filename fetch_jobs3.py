from duckduckgo_search import DDGS
import json

jobs = []

try:
    with DDGS() as ddgs:
        results = ddgs.text('site:ycombinator.com/companies "AI Agent" OR "Agentic AI" (developer OR engineer)', max_results=10)
        for r in results:
            jobs.append({
                'title': r.get('title'),
                'company': 'YC Startup',
                'location': 'Check Link',
                'salary': 'Unpublished',
                'url': r.get('href'),
                'summary': r.get('body'),
                'source': 'YC Jobs'
            })
except Exception as e:
    pass

print(json.dumps(jobs, indent=2))
