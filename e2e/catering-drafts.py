import datetime, sys, time
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
W=int(sys.argv[1]) if len(sys.argv)>1 else 390
tag=str(int(time.time())%100000)
errs=[]
d=(datetime.date.today()+datetime.timedelta(days=40+int(tag)%50)).isoformat()
def cleanup():
    import requests
    r=requests.Session(); H={'X-Requested-With':'rhr'}
    r.post('http://localhost:3001/api/auth/login',json={'username':'admin','password':'Admin12345x'},headers=H)
    for c in r.get('http://localhost:3001/api/meal-menu',params={'all':1}).json()['categories']:
        if c['name'].startswith('E2E Snacks'): r.delete(f"http://localhost:3001/api/meal-menu/categories/{c['id']}",headers=H)
    for dr in r.get('http://localhost:3001/api/drafts').json()['drafts']: r.delete(f"http://localhost:3001/api/drafts/{dr['id']}",headers=H)
cleanup()
def login(pg):
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('.bottom-nav')
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':W,'height':900}); pg=ctx.new_page()
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('response',lambda r: errs.append((r.status,r.url)) if r.status>=400 and 'auth' not in r.url else None)
    login(pg)
    tabs=pg.locator('.bottom-nav button').all_inner_texts(); print('tabs',tabs); assert tabs==['Home','Bookings','Calendar','Menu','More'], tabs
    # ---- More: two distinct entries
    pg.locator('.bottom-nav button',has_text='More').click()
    more=pg.locator('.more-item').all_inner_texts(); print('more',[m.replace('\n',' | ') for m in more if 'Catering' in m])
    assert any(m.startswith('Catering Menu') for m in more) and any(m.startswith('Catering Prices') for m in more)
    assert not any('tick items' in m for m in more)
    # ---- Catering Menu: simple default view, actions in ⋮
    pg.locator('.more-item',has_text='Catering Menu').click(); pg.wait_for_selector('[data-testid=add-category]')
    assert pg.get_by_role('button',name='Rename',exact=True).count()==0 and pg.get_by_role('button',name='Delete',exact=True).count()==0, 'actions crowd the default view'
    cn='E2E Snacks '+tag
    pg.get_by_test_id('add-category').click(); pg.get_by_label('Category name *').fill(cn); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(600)
    cat=pg.locator(f'[data-testid="cat-{cn}"]'); cat.locator('.mmcat__toggle').click()
    for nm in ['Medu Vada','Mini Samosa']:
        cat.get_by_role('button',name='Add item to').click(); pg.get_by_label('Item name *').fill(nm); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(500)
    cat.get_by_label(f'Actions for {cn}').click()
    print('category menu', pg.locator('.kebab__menu button').all_inner_texts()); pg.screenshot(path=S+f'k1_menu_{W}.png',full_page=True)
    assert pg.locator('.kebab__menu button').all_inner_texts()==['Rename','Deactivate','Move up','Move down','Delete']
    pg.keyboard.press('Escape')
    cat.get_by_label('Actions for Mini Samosa').click(); print('item menu', pg.locator('.kebab__menu button').all_inner_texts())
    assert pg.locator('.kebab__menu button').all_inner_texts()==['Edit','Deactivate','Move up','Move down','Delete']
    pg.get_by_role('menuitem',name='Move up').click(); pg.wait_for_timeout(500)
    print('order after move', cat.locator('.mealmgmt__name').all_inner_texts())
    # deactivate an extra item to prove it is hidden in orders later
    cat.get_by_role('button',name='Add item to').click(); pg.get_by_label('Item name *').fill('Hidden Bonda'); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(500)
    cat.get_by_label('Actions for Hidden Bonda').click(); pg.get_by_role('menuitem',name='Deactivate').click(); pg.wait_for_timeout(500)
    # delete needs confirmation
    cat.get_by_label('Actions for Hidden Bonda').click(); pg.get_by_role('menuitem',name='Delete').click(); pg.wait_for_selector('.modal'); print('confirm', pg.locator('.modal h2').inner_text()); pg.get_by_role('button',name='Cancel').click()
    # ---- Catering Prices
    pg.locator('.header__back').click(); pg.locator('.more-item',has_text='Catering Prices').click(); pg.wait_for_selector('[data-testid^=price-cat-]')
    pg.get_by_placeholder('Search items…').fill('Medu Vada'); pg.wait_for_timeout(300)
    row=pg.locator('.mealmgmt__row',has_text='Medu Vada'); print('price cell',row.inner_text().replace('\n',' | '))
    row.get_by_label('Edit price of Medu Vada').click(); pg.get_by_label('Price (₹) *').fill('12'); pg.locator('.modal select').select_option('piece'); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(600)
    print('price after', pg.locator('.mealmgmt__row',has_text='Medu Vada').inner_text().replace('\n',' | ')); pg.screenshot(path=S+f'k2_prices_{W}.png',full_page=True)
    pg.get_by_placeholder('Search items…').fill('Mini Samosa'); pg.wait_for_timeout(300)
    pg.locator('.mealmgmt__row',has_text='Mini Samosa').get_by_label('Edit price of Mini Samosa').click(); pg.get_by_label('Price (₹) *').fill('8'); pg.locator('.modal select').select_option('piece'); pg.get_by_role('button',name='Save').click(); pg.wait_for_timeout(600)
    # ---- Catering new order from the managed menu
    pg.locator('.bottom-nav button',has_text='Menu').click(); pg.get_by_test_id('orders-tab').click(); pg.wait_for_selector('.fab'); pg.locator('.fab').click(); pg.wait_for_selector('.cform')
    pg.locator('input').filter(has=pg.locator('xpath=self::*')).count()
    pg.get_by_label('Customer / organisation *').fill('Draft Caterer '+tag)
    pg.get_by_label('Phone *').fill('9000022233')
    pg.get_by_label('Plates / portions *').fill('150')
    picker=pg.get_by_test_id('catering-picker')
    pg.get_by_placeholder('Search menu items…').fill('Medu Vada'); pg.wait_for_timeout(300)
    names=picker.locator('.cpick__name').all_inner_texts(); print('search shows',names)
    pg.get_by_placeholder('Search menu items…').fill(''); pg.wait_for_timeout(200)
    picker.locator(f'[data-category="{cn}"] .cpick__head').click()
    shown=picker.locator(f'[data-category="{cn}"] .cpick__name').all_inner_texts(); print('active items shown',shown); assert 'Hidden Bonda' not in shown and 'Medu Vada' in shown
    picker.locator('.cpick__item',has_text='Medu Vada').locator('input[type=checkbox]').check()
    picker.locator('.cpick__item',has_text='Medu Vada').get_by_label('Quantity of Medu Vada').fill('200')
    picker.locator('.cpick__item',has_text='Mini Samosa').locator('input[type=checkbox]').check()
    picker.locator('.cpick__item',has_text='Mini Samosa').get_by_label('Quantity of Mini Samosa').fill('100')
    print('estimate', pg.locator('.payment-summary').inner_text().replace('\n',' | '))
    pg.screenshot(path=S+f'k3_cform_{W}.png',full_page=True)
    # ---- save as draft -> Home
    pg.get_by_test_id('save-draft').click(); pg.wait_for_selector('[data-testid=drafts-section]')
    cards=pg.locator('[data-testid=draft-card]'); print('drafts on home',cards.count()); 
    mine=cards.filter(has_text='Draft Caterer '+tag); print(mine.inner_text().replace('\n',' | ')); assert mine.count()==1 and 'Catering' in mine.inner_text()
    pg.screenshot(path=S+f'k4_home_{W}.png',full_page=True)
    pg.reload(); pg.wait_for_selector('[data-testid=drafts-section]'); assert pg.locator('[data-testid=draft-card]').filter(has_text='Draft Caterer '+tag).count()==1; print('draft survives refresh')
    # not an order, not in bookings
    # ---- continue: restored
    pg.locator('[data-testid=draft-card]').filter(has_text='Draft Caterer '+tag).get_by_test_id('draft-continue').click(); pg.wait_for_selector('.cform')
    assert pg.get_by_label('Customer / organisation *').input_value()=='Draft Caterer '+tag and pg.get_by_label('Plates / portions *').input_value()=='150'
    q=pg.get_by_label('Quantity of Medu Vada').input_value(); print('restored qty',q); assert q=='200'
    # finish required fields and create the order
    pg.get_by_label('Event type *').select_option('Wedding'); pg.get_by_label('Event date *').fill(d); pg.get_by_label('Food delivery time').fill('09:00')
    pg.get_by_label('Delivery address').fill('Test venue, Sulur')
    pg.get_by_role('button',name='Create order').click(); pg.wait_for_selector('.booking-detail__name, .cdetail, h2', timeout=8000); pg.wait_for_timeout(800)
    print('order created, url state:', pg.locator('.booking-detail__name').first.inner_text() if pg.locator('.booking-detail__name').count() else pg.locator('h2').first.inner_text())
    pg.locator('.bottom-nav button',has_text='Home').click(); pg.wait_for_selector('.sec-card')
    left=pg.locator('[data-testid=draft-card]').filter(has_text='Draft Caterer '+tag).count(); print('draft after submit',left); assert left==0
    # ---- hall booking draft: save, continue, delete with confirm
    pg.locator('[data-testid="section-Mini Hall"] button:has-text("New Booking")').click(); pg.wait_for_selector('.secform')
    pg.get_by_label('Customer name *').fill('Hall Draft '+tag); pg.get_by_label('Contact number *').fill('9000044455')
    pg.get_by_test_id('save-draft').click(); pg.wait_for_selector('[data-testid=drafts-section]')
    c=pg.locator('[data-testid=draft-card]').filter(has_text='Hall Draft '+tag); print(c.inner_text().replace('\n',' | ')); assert 'Hall' in c.inner_text() and 'Mini Hall' in c.inner_text()
    c.get_by_test_id('draft-continue').click(); pg.wait_for_selector('.secform'); assert pg.get_by_label('Customer name *').input_value()=='Hall Draft '+tag
    pg.get_by_label('Contact number *').fill('9000044466'); pg.get_by_test_id('save-draft').click(); pg.wait_for_selector('[data-testid=drafts-section]')
    assert pg.locator('[data-testid=draft-card]').filter(has_text='Hall Draft '+tag).count()==1, 'updating a draft must not duplicate it'
    pg.locator('[data-testid=draft-card]').filter(has_text='Hall Draft '+tag).get_by_test_id('draft-delete').click(); pg.wait_for_selector('.modal'); print('delete asks:',pg.locator('.modal h2').inner_text())
    pg.get_by_role('button',name='Delete draft').click(); pg.wait_for_timeout(700)
    assert pg.locator('[data-testid=draft-card]').filter(has_text='Hall Draft '+tag).count()==0; print('draft deleted')
    # ---- hall photo
    pg.locator('.header__pill').click(); pg.wait_for_selector('.hall-manage-card')
    pg.locator('.hall-manage-card',has_text='Mandapam').get_by_label('Edit Mandapam').click(); pg.get_by_role('tab',name='Photos').click()
    pg.get_by_test_id('hall-file-input').set_input_files(S+'hall.jpg'); pg.wait_for_timeout(1500); pg.get_by_role('button',name='Upload 1 photo').click(); pg.wait_for_timeout(2500); pg.locator('.modal__close').click(); pg.wait_for_timeout(400)
    pg.locator('.header__back').click(); pg.wait_for_selector('.sec-card--hall')
    print('mandapam photo', pg.locator('[data-testid="section-Mandapam"] .sec-card__photo img').count(), 'mini placeholder', pg.locator('[data-testid="section-Mini Hall"] .sec-card__photo--empty').count())
    heights={x:pg.locator(f'[data-testid="section-{x}"]').bounding_box()['height'] for x in ['Mandapam','Mini Hall']}; print('card heights',heights)
    pg.screenshot(path=S+f'k5_halls_{W}.png',full_page=True)
    print('overflow',pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'))
    b.close()
print('ERRS',errs)
