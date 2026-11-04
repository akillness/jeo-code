import urllib.request, json, urllib.parse
from bs4 import BeautifulSoup

def search_rp(keyword):
    url = f'https://www.rocketpunch.com/api/jobs/template?keywords={urllib.parse.quote(keyword)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        data = json.loads(res)
        soup = BeautifulSoup(data.get('data', {}).get('template', ''), 'html.parser')
        jobs = []
        for job_div in soup.select('.company-list .company'):
            title_elem = job_div.select_one('.job-title')
            company_elem = job_div.select_one('.company-name')
            if title_elem and company_elem:
                jobs.append({
                    'title': title_elem.text.strip(),
                    'company': company_elem.text.strip(),
                    'url': 'https://www.rocketpunch.com' + title_elem.get('href', ''),
                })
        return jobs
    except Exception as e:
        return []

print(json.dumps(search_rp('AI Agent'), ensure_ascii=False, indent=2))
