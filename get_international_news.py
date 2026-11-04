from gnews import GNews
import json

google_news = GNews(language='en', country='US', max_results=10)
international_news = google_news.get_news('AI Game')

with open('international_news.json', 'w', encoding='utf-8') as f:
    json.dump(international_news, f, ensure_ascii=False, indent=2)

print(f"Saved {len(international_news)} international news items.")
