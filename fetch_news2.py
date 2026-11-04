import urllib.request, urllib.parse, xml.etree.ElementTree as ET

def fetch_news(query, hl, gl, ceid, limit=10):
    encoded_query = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={encoded_query}&hl={hl}&gl={gl}&ceid={ceid}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req) as response:
            xml_data = response.read()
            root = ET.fromstring(xml_data)
            for item in root.findall('.//item')[:limit]:
                print(f"- {item.find('title').text} \n  URL: {item.find('link').text}")
    except Exception as e:
        print(e)

print("--- MORE KR ---")
fetch_news("AI 게임 개발 when:14d", "ko", "KR", "KR:ko")
print("--- MORE EN ---")
fetch_news("\"AI\" \"video game\" when:7d", "en-US", "US", "US:en")
