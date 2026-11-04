from duckduckgo_search import DDGS
import json

ddgs = DDGS()

def search_news(query, region='wt-wt', max_results=10):
    try:
        results = ddgs.news(query, region=region, safesearch='off', max_results=max_results)
        return list(results)
    except Exception as e:
        print(f"Error searching {query}: {e}")
        return []

domestic_news = search_news("AI 게임", region='kr-kr', max_results=15)
international_news = search_news("AI Game", region='us-en', max_results=15)

with open('news_results.json', 'w', encoding='utf-8') as f:
    json.dump({"domestic": domestic_news, "international": international_news}, f, ensure_ascii=False, indent=2)

print(f"Saved {len(domestic_news)} domestic and {len(international_news)} international news items.")
