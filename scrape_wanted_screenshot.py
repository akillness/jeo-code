from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('https://www.wanted.co.kr/search?query=AI%20Agent')
        page.wait_for_timeout(5000)
        page.screenshot(path="wanted.png")
        print("Screenshot saved to wanted.png")
        browser.close()

run()
