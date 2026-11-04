import requests
url = "https://www.wanted.co.kr/search?query=AI%20Agent"
headers = {'User-Agent': 'Mozilla/5.0'}
r = requests.get(url, headers=headers)
print("status:", r.status_code)
print("content len:", len(r.text))
