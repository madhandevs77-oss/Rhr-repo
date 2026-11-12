# Outsource date/time optional + automatic 3-hour end (with midnight rollover); bulk order pickup fields and multi-method advance.
import datetime, sys, time
from playwright.sync_api import sync_playwright
tag=str(int(time.time())%100000)
errs=[]
def check(cond,msg):
    print(('PASS ' if cond else 'FAIL ')+msg)
    if not cond: errs.append(msg)
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':390,'height':900}).new_page()
    pg.on('pageerror',lambda e:errs.append('pageerror '+str(e)))
    pg.on('response',lambda r: errs.append(f'http {r.status} {r.url}') if r.status>=400 and 'auth' not in r.url else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input'); i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('.bottom-nav')
    # ---------- A. Outsource
    pg.wait_for_selector('[data-testid=outsource-section]'); pg.locator('[data-testid=outsource-section] button, [data-testid=outsource-section] [role=button]').first.click(); pg.wait_for_selector('text=Customer name *')
    st=pg.get_by_label('Start time'); en=pg.get_by_label('End time'); dt=pg.get_by_label('Date',exact=True)
    check(dt.input_value()=='', 'Outsource date starts empty')
    check('*' not in pg.locator('label:has-text("Start time")').first.inner_text(), 'labels show no required star')
    st.fill('11:00'); check(en.input_value()=='14:00','11:00 -> end 14:00 (got %s)'%en.input_value())
    st.fill('22:30'); check(en.input_value()=='01:30','22:30 -> end 01:30 (got %s)'%en.input_value()); check(pg.locator('text=Ends the next day').count()==1,'"Ends the next day" hint shown')
    st.fill('21:00'); check(en.input_value()=='00:00','21:00 -> 00:00 next day')
    en.fill('18:00'); st.fill('10:00'); check(en.input_value()=='13:00','changing the start recalculates the end after a manual edit')
    st.fill(''); check(en.input_value()=='','clearing the start clears the end')
    # submit with NO date and NO time
    pg.get_by_label('Customer name *').fill('NoDate '+tag); pg.get_by_label('Contact number *').fill('9000011'+tag[-3:].zfill(3))
    pg.get_by_test_id('fulfilment-card').get_by_role('radio').filter(has_text='Takeaway').click()
    pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_timeout(1500)
    body=pg.inner_text('body'); check('Not set' in body and 'NoDate '+tag in body,'booking created without date/time; detail shows "Not set"')
    # appears in the Bookings list under "Date not set"
    pg.locator('.bottom-nav button',has_text='Bookings').click(); pg.wait_for_timeout(1200)
    check(pg.locator('text=Date not set').count()>=1 and pg.locator('.booking-card',has_text='NoDate '+tag).count()>=1,'undated booking listed under "Date not set"')
    # ---------- B. Bulk order
    pg.locator('.bottom-nav button',has_text='Menu').click(); pg.get_by_test_id('orders-tab').click(); pg.wait_for_selector('.fab'); pg.locator('.fab').click(); pg.wait_for_selector('.cform')
    check(pg.get_by_test_id('venue-name').count()==1 and pg.get_by_test_id('delivery-address').count()==1,'delivery: venue + address shown')
    pg.get_by_label('Fulfilment').select_option('pickup')
    check(pg.get_by_test_id('venue-name').count()==0 and pg.get_by_test_id('delivery-address').count()==0,'pickup: venue + address hidden')
    pg.get_by_label('Fulfilment').select_option('delivery')
    pg.get_by_label('Customer / organisation *').fill('Split '+tag); pg.get_by_label('Phone *').fill('9000022'+tag[-3:].zfill(3))
    pg.get_by_label('Event type *').select_option('Wedding'); d=(datetime.date.today()+datetime.timedelta(days=20+int(tag)%200)).isoformat(); pg.get_by_label('Event date *').fill(d)
    pg.get_by_label('Fulfilment').select_option('pickup')
    pg.get_by_label('Plates / portions *').fill('100'); pg.get_by_role('button',name='Per plate',exact=True).click(); pg.get_by_label('Price per plate (₹) *').fill('100')
    total=pg.get_by_test_id('advance-total')
    sp=pg.locator('.splitpay')
    sp.locator('label',has_text='Cash').locator('input').check()  if not sp.locator('label',has_text='Cash').locator('input').is_checked() else None
    check(sp.locator('label').count()>=6,'all supported methods are offered (%d)'%sp.locator('label').count())
    total.fill('1000'); check(not total.is_disabled() and total.get_attribute('readonly') is None,'single method: advance typed once')
    sp.locator('label',has_text='UPI').locator('input').check(); sp.locator('label',has_text='Card').locator('input').check()
    check(total.get_attribute('readonly') is not None,'several methods: advance total becomes automatic (read-only)')
    pg.get_by_label('Cash amount').fill('500'); pg.get_by_label('UPI amount').fill('300'); pg.get_by_label('Card amount').fill('200.50')
    check(total.input_value()=='1000.5','automatic total = 1000.5 (got %s)'%total.input_value())
    check('✓' in sp.inner_text(),'split total shows ✓')
    pg.get_by_label('UPI amount').fill('')                                 # blank amount -> refused
    pg.get_by_role('button',name='Create order').click(); pg.wait_for_timeout(600)
    check(pg.locator('.cform').count()==1 and pg.locator('[role=alert], .form-error').count()>=1,'blank method amount blocks submit with a message')
    pg.get_by_label('UPI amount').fill('-5'); pg.get_by_role('button',name='Create order').click(); pg.wait_for_timeout(600)
    check(pg.locator('.cform').count()==1,'negative amount blocked')
    pg.get_by_label('UPI amount').fill('300'); pg.get_by_role('button',name='Create order').click(); pg.wait_for_timeout(1800)
    body=pg.inner_text('body'); print(body[:600].replace('\n',' | '))
    check(pg.locator('.cform').count()==0,'order created')
    check('Cash' in body and 'UPI' in body and 'Card' in body,'detail shows each method')
    print('errors',errs); b.close()
sys.exit(1 if errs else 0)
