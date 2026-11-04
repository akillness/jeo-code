import urllib.request
import urllib.parse
import json

def fetch_jumpit(keyword):
    url = f"https://api.jumpit.co.kr/api/positions?keyword={urllib.parse.quote(keyword)}&sort=reg_dt"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        response = urllib.request.urlopen(req)
        data = json.loads(response.read().decode('utf-8'))
        return data.get('result', {}).get('positions', [])
    except Exception as e:
        return []

def get_details(position_id):
    url = f"https://api.jumpit.co.kr/api/position/{position_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        response = urllib.request.urlopen(req)
        data = json.loads(response.read().decode('utf-8'))
        return data.get('result', {})
    except:
        return {}

results = []
seen_ids = set()

for kw in ['"AI Agent"', '"AI Native"', '"에이전트"', '"LLM Agent"', 'Generative AI', '"AX"']:
    positions = fetch_jumpit(kw)
    for p in positions:
        pid = p['id']
        if pid in seen_ids:
            continue
            
        title = p.get('title', '').lower()
        company = p.get('companyName', '')
        
        # Check relevance
        if any(term in title for term in ['ai', 'agent', '에이전트', 'native', 'llm', 'genai', 'ax', '머신러닝']):
            details = get_details(pid)
            if details:
                # Double check the responsibility has agent/native
                resp = details.get('responsibility', '').lower()
                qual = details.get('qualifications', '').lower()
                if 'agent' in resp or 'native' in resp or 'agent' in title or 'native' in title or '에이전트' in resp or '에이전트' in title or 'llm' in resp:
                    seen_ids.add(pid)
                    results.append({
                        'title': p['title'],
                        'url': f"https://www.jumpit.co.kr/position/{pid}",
                        'company': company,
                        'location': p.get('locations', [''])[0] if p.get('locations') else '',
                        'qualifications': details.get('qualifications', '').strip(),
                        'summary': details.get('responsibility', '').strip(),
                        'salary': '회사 내규'
                    })
        if len(results) >= 5:
            break
    if len(results) >= 5:
        break

print(json.dumps(results[:5], ensure_ascii=False, indent=2))
