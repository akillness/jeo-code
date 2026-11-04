import requests
import json

# Find the most recent "Ask HN: Who is hiring?" thread
search_url = "https://hn.algolia.com/api/v1/search_by_date?query=Who+is+hiring&tags=story&hitsPerPage=20"
response = requests.get(search_url).json()

thread_id = None
for hit in response.get('hits', []):
    if "Ask HN: Who is hiring?" in hit.get('title', ''):
        thread_id = hit['objectID']
        print(f"Found thread: {hit['title']} (ID: {thread_id})")
        break

if not thread_id:
    print("Could not find thread")
    exit(1)

# Fetch comments for the thread
comments_url = f"https://hn.algolia.com/api/v1/search?tags=comment,story_{thread_id}&hitsPerPage=1000"
comments_response = requests.get(comments_url).json()

ai_jobs = []
for comment in comments_response.get('hits', []):
    text = comment.get('comment_text', '').lower()
    if ('ai agent' in text or 'ai native' in text or 'agentic' in text or 'agent' in text):
        ai_jobs.append(comment)

print(f"Found {len(ai_jobs)} relevant jobs.")
for job in ai_jobs[:5]:
    print("-" * 40)
    print("Author:", job.get('author'))
    print("Text snippet:", job.get('comment_text', '')[:500])
