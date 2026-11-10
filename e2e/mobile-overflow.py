from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/shots/'
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':390,'height':800}).new_page()
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('[data-testid=manage-halls]')
    pg.locator('.bottom-nav button',has_text='Menu').click(); pg.get_by_test_id('orders-tab').click(); pg.wait_for_timeout(500)
    pg.locator('.fab').first.click(); pg.wait_for_timeout(800)
    # overflow audit across screens
    print('scrollWidth',pg.evaluate('document.documentElement.scrollWidth'),'client',pg.evaluate('document.documentElement.clientWidth'))
    over=pg.evaluate("""[...document.querySelectorAll('input,select,textarea')].filter(e=>e.getBoundingClientRect().right>window.innerWidth).length""")
    print('overflowing fields',over)
    b.close()
