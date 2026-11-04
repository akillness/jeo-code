import urllib.request, json

def get_jobs(keyword):
    url = f'https://api.jumpit.co.kr/api/positions?sort=relation&keyword={urllib.parse.quote(keyword)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        return json.loads(res).get('result', {}).get('positions', [])
    except Exception as e:
        return []

def get_job_detail(job_id):
    url = f'https://api.jumpit.co.kr/api/position/{job_id}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        return json.loads(res).get('result', {})
    except Exception as e:
        return {}

import urllib.parse
jobs = []
for kw in ['AI Agent', 'AI Native']:
    for job in get_jobs(kw)[:5]:
        if 'AI' in job.get('title', ''):
            detail = get_job_detail(job.get('id'))
            jobs.append({
                'title': job.get('title'),
                'company': job.get('companyName'),
                'location': ', '.join(job.get('locations', [])),
                'url': f"https://www.jumpit.co.kr/position/{job.get('id')}",
                'qualifications': detail.get('qualifications', ''),
                'responsibility': detail.get('responsibility', ''),
                'workingConditions': detail.get('workingConditions', '')
            })

print(json.dumps(jobs, ensure_ascii=False, indent=2))
