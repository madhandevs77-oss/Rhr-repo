import datetime, sys, time
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
tag=str(int(time.time())%100000); errs=[]
d=(datetime.date.today()+datetime.timedelta(days=90+int(tag)%200)).isoformat()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':390,'height':900}).new_page()
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('response',lambda r: errs.append((r.status,r.url)) if r.status>=400 and 'auth' not in r.url else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input'); i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('.bottom-nav')
    tabs=pg.locator('.bottom-nav button').all_inner_texts(); print(tabs); assert tabs==['Home','Bookings','Calendar','Menu','More'], tabs
    pg.locator('.bottom-nav button',has_text='Menu').click(); pg.wait_for_selector('.food-category')
    pg.get_by_test_id('orders-tab').click(); pg.wait_for_selector('.fab'); print('orders view ok:', pg.locator('.fab').inner_text())
    pg.screenshot(path=S+'o1_orders.png')
    # outsource booking
    pg.locator('.bottom-nav button',has_text='Home').click(); pg.wait_for_selector('[data-testid=outsource-section]')
    pg.locator('[data-testid=outsource-section] button, [data-testid=outsource-section] [role=button]').first.click(); pg.wait_for_timeout(500)
    print('url state:', pg.locator('h2').first.inner_text())
    assert pg.get_by_test_id('fulfilment-card').count()==1
    assert pg.get_by_label('Maintenance charge (₹)').count()==0, 'maintenance should be hidden for outsource'
    pg.get_by_test_id('fulfil-delivery').click(); pg.get_by_test_id('delivery-address').wait_for()
    pg.get_by_label('Customer name *').fill('Out '+tag); pg.get_by_label('Contact number *').fill('9000077'+tag[-3:].zfill(3))
    pg.get_by_label('Date',exact=True).fill(d); pg.get_by_label('Start time',exact=True).fill('11:00')
    # delivery without an address must be refused
    pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_selector('.form-error'); print('no-address error:', pg.locator('.form-error').inner_text())
    pg.get_by_test_id('delivery-address').fill('12 Gandhi Nagar, Sulur')
    pg.screenshot(path=S+'o2_form.png', full_page=True)
    pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_selector('.booking-detail__name')
    body=pg.locator('body').inner_text(); assert 'Delivery address' in body and '12 Gandhi Nagar' in body; print('detail shows delivery')
    pg.screenshot(path=S+'o3_detail.png', full_page=True)
    # calendar
    pg.locator('.bottom-nav button',has_text='Calendar').click(); pg.wait_for_selector('.cal-day')
    for _ in range(12):
        if pg.locator(f'[data-date="{d}"]').count(): break
        pg.get_by_label('Next month').click(); pg.wait_for_timeout(200)
    pg.locator(f'[data-date="{d}"]').click(); pg.wait_for_selector('[data-testid=cal-fulfilment]')
    print('calendar:', pg.locator('[data-testid=cal-fulfilment]').first.inner_text()); pg.screenshot(path=S+'o4_calendar.png', full_page=True)
    b.close()
print('errors:',errs)
