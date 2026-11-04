import urllib.request
import urllib.parse
from bs4 import BeautifulSoup
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

query = urllib.parse.quote('site:wanted.co.kr/wd "AI Agent"')
url = f"https://html.duckduckgo.com/html/?q={query}"

req = urllib.request.Request(
    url,
    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
)
try:
    html = urllib.request.urlopen(req, context=ctx).read()
    soup = BeautifulSoup(html, 'html.parser')
    for a in soup.select('.result__a'):
        print(a.text)
        print(a.get('href', ''))
        print("---")
except Exception as e:
    print("Error:", e)
