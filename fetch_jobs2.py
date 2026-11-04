from duckduckgo_search import DDGS
import json

jobs = []

try:
    with DDGS() as ddgs:
        # Search directly for AI agent jobs
        results = ddgs.text('"AI Agent" OR "AI Native" OR "Agentic" hiring developer engineer jobs', timelimit='m', max_results=15)
        for r in results:
            title = r.get('title')
            url = r.get('href')
            summary = r.get('body')
            
            # Simple heuristic to filter out non-job board stuff
            is_job = 'job' in title.lower() or 'hiring' in title.lower() or 'careers' in url.lower() or 'lever.co' in url or 'greenhouse.io' in url or 'workable' in url or 'ycombinator' in url
            
            jobs.append({
                'title': title,
                'company': 'Various / Check Link',
                'location': 'Check Link',
                'salary': 'Unpublished',
                'url': url,
                'summary': summary,
                'source': 'Web Search',
                'is_job': is_job
            })
except Exception as e:
    pass

print(json.dumps([j for j in jobs if j['is_job']], indent=2))
