import urllib.request
import urllib.parse
import json
import time

def fetch_jumpit(keyword):
    url = f'https://api.jumpit.co.kr/api/positions?sort=relation&keyword={urllib.parse.quote(keyword)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        data = json.loads(res)
        positions = data.get('result', {}).get('positions', [])
        
        results = []
        for p in positions[:15]: 
            job_id = p.get('id')
            detail_url = f'https://api.jumpit.co.kr/api/position/{job_id}'
            d_req = urllib.request.Request(detail_url, headers={'User-Agent': 'Mozilla/5.0'})
            try:
                d_res = urllib.request.urlopen(d_req).read()
                detail = json.loads(d_res).get('result', {})
            except Exception as e:
                detail = {}
            
            title = p.get('title', '')
            quals = detail.get('qualifications', '')
            resp = detail.get('responsibility', '')
            
            # Strict filtering for AI Agent / AI Native
            text_to_search = (title + quals + resp).lower()
            if 'agent' in text_to_search or '에이전트' in text_to_search or 'ai native' in text_to_search:
                results.append({
                    'title': title,
                    'company': p.get('companyName'),
                    'location': ', '.join(p.get('locations', [])),
                    'qualifications': quals,
                    'responsibility': resp,
                    'url': f'https://www.jumpit.co.kr/position/{job_id}'
                })
            time.sleep(0.3)
        return results
    except Exception as e:
        return []

all_jobs = []
for kw in ["AI Agent", "AI Native"]:
    jobs = fetch_jumpit(kw)
    all_jobs.extend(jobs)

# Deduplicate
seen = set()
unique_jobs = []
for job in all_jobs:
    if job['url'] not in seen:
        seen.add(job['url'])
        unique_jobs.append(job)

print(json.dumps(unique_jobs, ensure_ascii=False))