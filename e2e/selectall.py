import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':390,'height':900}).new_page()
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('.sec-card'); pg.locator('[data-testid="section-Mini Hall"] button:has-text("New Booking")').click(); pg.wait_for_selector('.secform')
    cat=pg.locator('[data-category="Royal Breakfast"]'); n=cat.locator('.food-list__items input').count()
    cat.get_by_label('Select all in Royal Breakfast').check(); print('all ->',cat.locator('.food-list__items input:checked').count(),'of',n, cat.locator('small').inner_text())
    cat.locator('.food-list__items input').first.uncheck(); print('indeterminate',cat.get_by_label('Select all in Royal Breakfast').evaluate('e=>e.indeterminate'))
    cat.get_by_label('Select all in Royal Breakfast').check(); cat.get_by_label('Select all in Royal Breakfast').uncheck(); print('none ->',cat.locator('.food-list__items input:checked').count())
    cat.get_by_label('Select all in Royal Breakfast').check(); pg.screenshot(path='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/shots/selall.png'); b.close()
