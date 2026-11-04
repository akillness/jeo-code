import urllib.request
import json

boards = ['anthropic', 'openai', 'cohere', 'langchain', 'scaleai', 'huggingface']
jobs = []

for board in boards:
    try:
        url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        res = urllib.request.urlopen(req)
        data = json.loads(res.read())
        
        for job in data.get('jobs', []):
            title = job.get('title', '').lower()
            if 'agent' in title or 'ai' in title or 'research' in title:
                jobs.append({
                    'title': job.get('title'),
                    'company': board.capitalize(),
                    'location': job.get('location', {}).get('name', 'Remote'),
                    'salary': 'Unpublished',
                    'url': job.get('absolute_url'),
                    'summary': f"Role at {board.capitalize()} focusing on {job.get('title')}",
                    'source': 'Greenhouse API'
                })
    except Exception as e:
        pass

# Also try Lever for some companies (e.g. Midjourney? Not sure if lever or greenhouse)
# Let's print the jobs found
print(json.dumps(jobs, indent=2))
