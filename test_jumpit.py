import urllib.request
import urllib.parse
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = 'https://www.jumpit.co.kr/api/positions?keyword=AI%20Agent&sort=relation'
req = urllib.request.Request(
    url,
    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
)
try:
    print(urllib.request.urlopen(req, context=ctx).read().decode('utf-8')[:500])
except Exception as e:
    print("Error:", e)
