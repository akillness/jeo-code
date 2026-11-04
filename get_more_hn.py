import json

with open("hn_jobs2.py", "r") as f:
    pass # we can just modify and run

import requests
search_url = "https://hn.algolia.com/api/v1/search_by_date?query=Who+is+hiring&tags=story&hitsPerPage=20"
response = requests.get(search_url).json()

thread_id = None
for hit in response.get('hits', []):
    if "Ask HN: Who is hiring?" in hit.get('title', ''):
        thread_id = hit['objectID']
        break

comments_url = f"https://hn.algolia.com/api/v1/search?tags=comment,story_{thread_id}&hitsPerPage=1000"
comments_response = requests.get(comments_url).json()

ai_jobs = []
for comment in comments_response.get('hits', []):
    text = comment.get('comment_text', '').lower()
    if 'ai agent' in text or 'ai native' in text or 'agentic' in text:
        ai_jobs.append(comment)

for i, job in enumerate(ai_jobs[:10]):
    print(f"--- Job {i+1} ---")
    print(job.get('comment_text', '')[:800])

