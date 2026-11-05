import datetime, sys, time
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
W=int(sys.argv[1]) if len(sys.argv)>1 else 390
tag=str(int(time.time())%100000); errs=[]
d=(datetime.date.today()+datetime.timedelta(days=30+int(tag)%40)).isoformat()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':W,'height':900}).new_page()
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('response',lambda r: errs.append((r.status,r.url)) if r.status>=400 and 'auth' not in r.url else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input'); i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('.bottom-nav')
    tabs=pg.locator('.bottom-nav button').all_inner_texts(); print(tabs); assert tabs==['Home','Bookings','Calendar','Catering','Menu','More']
    pg.locator('.bottom-nav button',has_text='Menu').click(); pg.wait_for_selector('.food-category')
    pg.get_by_placeholder('Search dishes…').fill('Idly'); pg.wait_for_timeout(300)
    pg.get_by_label('Select Idly').first.check()
    pg.get_by_placeholder('Search dishes…').fill(''); pg.wait_for_timeout(200)
    cat=pg.locator('[data-category="Beverages"]'); cat.locator('.mmcat__toggle').click(); cat.get_by_test_id('pick-all-Beverages').click()
    print('bar:',pg.locator('.pick-bar').inner_text().replace('\n',' | ')); pg.screenshot(path=S+f'm1_menu_{W}.png',full_page=True)
    pg.get_by_test_id('use-in-order').click(); pg.wait_for_selector('.cform')
    opts=pg.locator('.opt-pick strong').all_inner_texts(); print('service types',opts); assert 'Full Catering Service' in opts and 'Bulk Food Supply Only' in opts
    print('picker header',pg.locator('.cpick .extras__head strong').inner_text()); sel=pg.locator('.cpick__item.is-on .cpick__name').all_inner_texts(); print('selected',sel); assert len(sel)==5 and 'Idly' in sel
    pg.locator('.opt-pick',has_text='Bulk Food Supply Only').click()
    pg.get_by_label('Customer / organisation *').fill('Menu Tab '+tag); pg.get_by_label('Phone *').fill('9000055566'); pg.get_by_label('Plates / portions *').fill('80')
    pg.get_by_label('Event type *').select_option('Wedding'); pg.get_by_label('Event date *').fill(d); pg.get_by_label('Food delivery time').fill('08:30'); pg.get_by_label('Delivery address').fill('Hall road, Sulur')
    print('mode:',pg.locator('.seg button.active').inner_text()); pg.get_by_label('Price per plate (₹) *').fill('250')
    pg.screenshot(path=S+f'm2_order_{W}.png',full_page=True)
    pg.get_by_role('button',name='Create order').click(); pg.wait_for_timeout(1500)
    if pg.locator('.form-error').count(): print('FORM ERROR:',pg.locator('.form-error').inner_text())
    pg.wait_for_selector('.booking-detail__name'); pg.wait_for_timeout(300)
    print('created for',pg.locator('.booking-detail__name').first.inner_text(), '|', pg.locator('.booking-detail__ref').first.inner_text())
    # picked list must be empty for the next order
    pg.locator('.bottom-nav button',has_text='Catering').click(); pg.locator('.fab').click(); pg.wait_for_selector('.cform'); print('next new order starts with items:',pg.locator('.cpick__item.is-on').count()); assert pg.locator('.cpick__item.is-on').count()==0
    pg.locator('.header__back').click()
    # edit the created order: items restored
    pg.get_by_text('Menu Tab '+tag).first.click(); pg.wait_for_selector('.booking-detail__name')
    pg.get_by_role('button',name='Edit',exact=False).first.click(); pg.wait_for_selector('.cform')
    print('edit restored',pg.locator('.cpick__item.is-on').count(), pg.locator('.opt-pick.selected strong').inner_text()); assert pg.locator('.cpick__item.is-on').count()==5
    pg.get_by_label('Quantity of Idly').fill('7'); pg.get_by_role('button',name='Save changes').click(); pg.wait_for_timeout(1200)
    print('after save:', pg.locator('h2, .booking-detail__name').first.inner_text())
    print('overflow',pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth'))
    b.close()
print('ERRS',errs)
