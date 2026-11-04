from playwright.sync_api import sync_playwright
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('https://www.wanted.co.kr/search?query=AI%20Agent')
        time.sleep(5) # wait for js to load
        
        # get job cards
        jobs = page.evaluate('''() => {
            let cards = document.querySelectorAll('div[class*="JobCard_"] a, a[data-attribute-id="position__click"]');
            let results = [];
            cards.forEach(card => {
                let title = card.querySelector('strong')?.innerText || card.querySelector('div[class*="JobCard_title"]')?.innerText || '';
                let company = card.querySelector('span[class*="JobCard_companyName"]')?.innerText || card.querySelector('span[class*="JobCard_company"]')?.innerText || '';
                let link = card.href;
                if (title && link) {
                    results.push({title, company, link});
                }
            });
            return results;
        }''')
        
        for idx, job in enumerate(jobs[:5]):
            print(f"--- Job {idx+1} ---")
            print("Title:", job['title'])
            print("Company:", job['company'])
            print("Link:", job['link'])
            
        browser.close()

run()
