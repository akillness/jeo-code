import urllib.request
import urllib.parse
import re
import html

def fetch_ddg(query):
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    url = 'https://html.duckduckgo.com/html/?q=' + urllib.parse.quote(query)
    try:
        req = urllib.request.Request(url, headers=headers)
        html_content = urllib.request.urlopen(req).read().decode('utf-8')
        
        results = []
        for match in re.finditer(r'<a class="result__url" href="([^"]+)".*?<h2 class="result__title">.*?<a[^>]+>(.*?)</a>.*?<a class="result__snippet[^>]+>(.*?)</a>', html_content, re.IGNORECASE | re.DOTALL):
            link = urllib.parse.unquote(match.group(1).split('uddg=')[1].split('&')[0]) if 'uddg=' in match.group(1) else match.group(1)
            title = re.sub(r'<[^>]+>', '', match.group(2)).strip()
            title = html.unescape(title)
            snippet = re.sub(r'<[^>]+>', '', match.group(3)).strip()
            snippet = html.unescape(snippet)
            results.append({"title": title, "link": link, "snippet": snippet})
        return results
    except Exception as e:
        return str(e)

print(fetch_ddg('site:wanted.co.kr "AI Agent" OR "AI Native"'))
