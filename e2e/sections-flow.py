import datetime, sys
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/shots/'
W=int(sys.argv[1]) if len(sys.argv)>1 else 390
errs=[]
d=(datetime.date.today()+datetime.timedelta(days=int(sys.argv[2]) if len(sys.argv)>2 else 33)).isoformat()
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':W,'height':900}); pg=ctx.new_page()
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('response',lambda r: errs.append((r.status,r.url)) if r.status>=400 else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('.sec-card')
    print('cards',pg.locator('.sec-card').count())
    print('halls cards',pg.locator('[data-testid=halls-section] .sec-card').count(),'outsource cards',pg.locator('[data-testid=outsource-section] .sec-card').count())
    print('headings',[h.inner_text() for h in pg.locator('.section__title').all()][:3])
    hn=pg.locator('[data-testid=halls-section] .sec-card h3').all_inner_texts(); print('halls',hn); assert hn[:2]==['Mandapam','Mini Hall'] and not any('Outsource' in x for x in hn)
    assert pg.locator('text=Our Halls').count()==0
    assert pg.locator('[data-testid=outsource-section] .sec-card').count()==5
    assert pg.locator('text=/guest|capacity/i').count()==0
    # footer: Menu Management -> create a category and an item
    pg.locator('.bottom-nav button',has_text='More').click(); pg.locator('.more-item',has_text='Catering Menu').click(); pg.wait_for_selector('[data-testid=add-category]')
    cn='Royal Special '+d[-2:]+pg.evaluate('Date.now()%1000').__str__()
    pg.get_by_test_id('add-category').click(); pg.get_by_label('Category name *').fill(cn); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(700)
    pg.locator(f'[data-testid="cat-{cn}"] .mmcat__toggle').click()
    pg.locator(f'[data-testid="cat-{cn}"]').get_by_role('button',name='Add item to').click(); pg.get_by_label('Item name *').fill('Special Paneer Butter'); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(700)
    print('new cat items', pg.locator(f'[data-testid="cat-{cn}"] .mealmgmt__name').all_inner_texts())
    pg.screenshot(path=S+f's0_menumgmt_{W}.png',full_page=True)
    pg.locator('.bottom-nav button',has_text='Home').click(); pg.wait_for_selector('.sec-card')
    pg.screenshot(path=S+f's1_dash_{W}.png',full_page=True)
    pg.locator('[data-testid="section-Mini Hall"] button:has-text("New Booking")').click()
    pg.wait_for_selector('.secform')
    assert pg.locator('text=/guest|capacity/i').count()==0, 'guest field present'
    pg.get_by_label('Customer name *').fill('Menu Tester'); pg.get_by_label('Contact number *').fill('9000011122')
    pg.locator('input[type=date]').first.fill(d)
    pg.locator('input[type=time]').nth(0).fill('10:00')
    print('end auto', pg.locator('input[type=time]').nth(1).input_value())
    pg.locator('[data-category="Royal Breakfast"] .food-list__item',has_text='Idly').first.locator('input').check()
    pg.locator('[data-category="Royal Lunch"] .food-list__item',has_text='Rasam').first.locator('input').check()
    pg.locator(f'[data-category="{cn}"] .food-list__item',has_text='Special Paneer').first.locator('input').check()
    assert '₹' not in pg.locator('.mealpick').inner_text(), 'price in menu picker'
    pg.get_by_label('Notes').fill('private note')
    pg.get_by_label('Food-service amount',exact=False).fill('4750')
    print('summary', pg.locator('.payment-summary').first.inner_text().replace('\n',' | '))
    pg.get_by_label('Extra amount (₹)').fill('250')
    pg.get_by_role('button',name='+ Add').click(); pg.get_by_label('Charge reason').fill('GST 5%'); pg.get_by_label('Charge amount').fill('250')
    pg.get_by_label('Advance (₹)').fill('5000')
    pg.locator('.splitpay__check',has_text='Card').locator('input').check()
    pg.get_by_label('Cash amount').fill('2000'); pg.get_by_label('Card amount').fill('3000')
    pg.screenshot(path=S+f's2_form_{W}.png',full_page=True)
    ov=pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'); print('overflow',ov)
    pg.get_by_role('button',name='Save & confirm booking').click()
    pg.wait_for_selector('.booking-detail__name'); pg.wait_for_timeout(600)
    print('detail', pg.locator('.booking-detail__status').first.inner_text())
    pg.screenshot(path=S+f's3_detail_{W}.png',full_page=True)
    print('paymentrow', pg.locator('.payment-history-item__method').first.inner_text())
    pg.get_by_role('button',name='Food',exact=False).first.click(); pg.wait_for_timeout(300)
    pg.get_by_test_id('open-menu-print').click(); pg.wait_for_selector('[data-testid=menu-print-area]', state='attached')
    t=pg.locator('[data-testid=menu-print-preview]').inner_text(); print('MENU:',t.replace('\n',' / '))
    for bad in ['Menu Tester','9000011122','₹','GST','private','BH-']: assert bad not in t, bad
    pg.emulate_media(media='print'); pg.pdf(path=S+f'menu_print_{W}.pdf',format='A4'); pg.emulate_media(media='screen')
    pg.screenshot(path=S+f's4_menu_{W}.png')
    pg.locator('.modal__close').click()
    pg.get_by_role('button',name='Payments',exact=False).first.click(); pg.wait_for_timeout(300)
    print('receipt links',pg.get_by_test_id('receipt-link').count(),'bill link',pg.get_by_test_id('customer-bill').count())
    pg.screenshot(path=S+f's4b_pay_{W}.png',full_page=True)
    # calendar
    pg.locator('.bottom-nav button',has_text='Calendar').click(); pg.wait_for_selector('.cal-grid')
    for _ in range(2):
        if pg.locator(f'[data-date="{d}"]').count(): break
        pg.locator('.month-selector button, .month-nav button').last.click(); pg.wait_for_timeout(500)
    pg.wait_for_timeout(500)
    print('dot', pg.locator(f'[data-date="{d}"] [data-testid=cal-dot]').count())
    pg.locator(f'[data-date="{d}"]').click(); pg.wait_for_timeout(700)
    pg.screenshot(path=S+f's5_cal_{W}.png',full_page=True)
    print('calsections', pg.locator('.cal-sec__title').count())
    b.close()
print('ERRS',errs)
