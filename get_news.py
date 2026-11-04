import sys
try:
    from duckduckgo_search import DDGS
except ImportError:
    print("DDGS not found")
    sys.exit(1)

ddgs = DDGS()
print("--- KR NEWS ---")
kr_news = list(ddgs.news("AI 게임", region="kr-kr", safesearch="off", timelimit="w", max_results=10))
for n in kr_news:
    print(n['title'])
    print(n['url'])
    print(n.get('body', ''))
    print("===")

print("--- EN NEWS ---")
en_news = list(ddgs.news("AI gaming", region="us-en", safesearch="off", timelimit="w", max_results=10))
for n in en_news:
    print(n['title'])
    print(n['url'])
    print(n.get('body', ''))
    print("===")
