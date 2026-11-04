import urllib.request
import urllib.parse
import json

def fetch_rocketpunch(keyword):
    url = f'https://www.rocketpunch.com/api/jobs/template?keywords={urllib.parse.quote(keyword)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req).read()
        data = json.loads(res)
        return data.get('data', {}).get('template', '')
    except Exception as e:
        return str(e)

print(fetch_rocketpunch("AI Agent")[:1000])
