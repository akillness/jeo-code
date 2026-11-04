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
        return data.get('result', {}).get('positions', [])
    except Exception as e:
        return []

def fetch_detail(job_id):
    url = f'https://api.jumpit.co.kr/api/position/{job_id}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        return json.loads(res).get('result', {})
    except Exception as e:
        return {}

positions = []
for kw in ['AI Agent', 'AI Native']:
    pos = fetch_jumpit(kw)
    for p in pos:
        if p['id'] not in [x['id'] for x in positions]:
            positions.append(p)
    time.sleep(1)

results = []
for p in positions[:7]:
    detail = fetch_detail(p['id'])
    if not detail:
        continue
        
    results.append({
        'id': p['id'],
        'title': p['title'],
        'company': p['companyName'],
        'location': p.get('locations', [''])[0] if p.get('locations') else '미상',
        'url': f"https://www.jumpit.co.kr/position/{p['id']}",
        'qualifications': detail.get('qualifications', ''),
        'responsibility': detail.get('responsibility', '')
    })
    time.sleep(0.5)

print(json.dumps(results, ensure_ascii=False, indent=2))
