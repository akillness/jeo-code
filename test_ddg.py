import urllib.request
import urllib.parse

ctx = __import__('ssl').create_default_context()
ctx.check_hostname = False
ctx.verify_mode = __import__('ssl').CERT_NONE

query = urllib.parse.quote('site:wanted.co.kr/wd "AI Agent"')
url = f"https://html.duckduckgo.com/html/?q={query}"

req = urllib.request.Request(
    url,
    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
)
try:
    html = urllib.request.urlopen(req, context=ctx).read().decode('utf-8')
    print("Found links:")
    for line in html.split('\n'):
        if 'class="result__a"' in line or 'href="' in line:
            if 'wanted.co.kr' in line:
                print(line.strip())
except Exception as e:
    print("Error:", e)
