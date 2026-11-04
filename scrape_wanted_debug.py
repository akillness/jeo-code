from playwright.sync_api import sync_playwright
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('https://www.wanted.co.kr/search?query=AI%20Agent')
        time.sleep(5)
        
        links = page.evaluate('''() => {
            let anchors = Array.from(document.querySelectorAll('a'));
            return anchors.map(a => {
                return { text: a.innerText, href: a.href, className: a.className };
            }).filter(a => a.href.includes('/wd/'));
        }''')
        
        for idx, link in enumerate(links[:20]):
            text = link['text'].replace('\n', ' ').strip()
            print(f"[{idx}] {text} | {link['href']}")
            
        browser.close()

run()
