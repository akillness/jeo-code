from playwright.sync_api import sync_playwright

urls = [
    "https://jumpit.saramin.co.kr/position/54360177",
    "https://jumpit.saramin.co.kr/position/54396628",
    "https://jumpit.saramin.co.kr/position/54202006",
    "https://jumpit.saramin.co.kr/position/54405169"
]

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        for url in urls:
            print(f"=== Fetching {url} ===")
            page.goto(url)
            page.wait_for_timeout(3000)
            
            content = page.evaluate('''() => {
                let positionName = document.querySelector('h1')?.innerText || '';
                let companyName = document.querySelector('a[href*="/company/"]')?.innerText || '';
                
                let details = Array.from(document.querySelectorAll('section'));
                let text = details.map(s => s.innerText).join(' | ');
                
                let meta = {};
                document.querySelectorAll('dl').forEach(dl => {
                    let dts = dl.querySelectorAll('dt');
                    let dds = dl.querySelectorAll('dd');
                    for (let i = 0; i < dts.length; i++) {
                        meta[dts[i].innerText] = dds[i]?.innerText || '';
                    }
                });
                
                return { positionName, companyName, text, meta };
            }''')
            
            print(f"Position: {content['positionName']}")
            print(f"Company: {content['companyName']}")
            print(f"Meta: {content['meta']}")
            
            text = content['text']
            print("--- Snippets ---")
            lines = [l for l in text.split('\n') if len(l.strip()) > 0]
            for i, line in enumerate(lines):
                if any(k in line for k in ['주요업무', '자격요건', '우대사항', '급여']):
                    print(line)
                    for j in range(1, 10):
                        if i+j < len(lines) and not any(k in lines[i+j] for k in ['주요업무', '자격요건', '우대사항', '급여', '기술스택']):
                            print("  ", lines[i+j])
                        else:
                            break
            print("\n")
            
        browser.close()

run()
