from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('https://www.jumpit.co.kr/search?keyword=AI%20Agent')
        page.wait_for_timeout(3000)
        
        links = page.evaluate('''() => {
            let anchors = Array.from(document.querySelectorAll('a'));
            return anchors.map(a => {
                return { text: a.innerText, href: a.href };
            }).filter(a => a.href.includes('/position/'));
        }''')
        
        for idx, link in enumerate(links[:20]):
            text = link['text'].replace('\n', ' ').strip()
            if text:
                print(f"[{idx}] {text} | {link['href']}")
            
        browser.close()

run()
