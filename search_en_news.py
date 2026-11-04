import json
import requests
from bs4 import BeautifulSoup

url = "https://news.google.com/rss/search?q=AI+Game+when:7d&hl=en-US&gl=US&ceid=US:en"
res = requests.get(url)
soup = BeautifulSoup(res.text, "xml")

en_news = []
for item in soup.find_all('item')[:5]:
    title = item.title.text
    link = item.link.text
    desc = item.description.text if item.description else ""
    en_news.append({"title": title, "url": link, "body": desc[:100]})

with open('results.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

data['en_news'] = en_news

with open('results.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print("Updated en_news")
