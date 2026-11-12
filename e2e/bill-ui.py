import datetime, json
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/shots/'
H={'X-Requested-With':'rhr','Content-Type':'application/json'}
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':800}); pg=ctx.new_page()
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('response',lambda r: errs.append((r.status,r.url)) if r.status>=400 else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('[data-testid=manage-halls]')
    api=ctx.request
    halls=api.get('http://localhost:3001/api/halls').json()['halls']
    d=(datetime.date.today()+datetime.timedelta(days=61+int(__import__('time').time())%400)).isoformat()
    bk=api.post('http://localhost:3001/api/bookings',headers=H,data=json.dumps({'customer':{'name':'Email Customer','phone':'9876500078','email':'customer@example.com','messageConsent':True},'hallId':halls[0]['id'],'eventType':'Wedding','date':d,'startTime':'09:00','endTime':'12:00','guests':50,'hallCharge':8000,'discount':0,'taxRate':0,'charges':[],'foodItems':[],'advance':{'amount':8000,'method':'Cash','paidOn':datetime.date.today().isoformat(),'verify':True,'idempotencyKey':'e2e-'+d}}))
    print('create',bk.status, bk.text()[:160] if bk.status>=400 else ''); bid=bk.json()['booking']['id']
    pg.wait_for_timeout(3500)  # worker sends (mock)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('[data-testid=manage-halls]')
    pg.get_by_placeholder('Search').first.fill('Email Customer'); pg.wait_for_timeout(900)
    pg.get_by_text('Email Customer').first.click(); pg.wait_for_timeout(900)
    for t in []:
        pg.get_by_role('button',name=t).first.click(); pg.wait_for_timeout(300)
    pg.screenshot(path=S+'z_detail.png',full_page=True)
    pg.get_by_role('button',name='Send to customer').first.click(); pg.wait_for_timeout(400)
    pg.screenshot(path=S+'z_sendmodal.png')
    pg.get_by_role('button',name='Send',exact=True).click(); pg.wait_for_timeout(1500)
    pg.screenshot(path=S+'z_sent.png',full_page=True)
    # settings + template
    pg.locator('.bottom-nav button',has_text='More').click(); pg.wait_for_timeout(400)
    pg.locator('.more-item',has_text='Settings').first.click(); pg.wait_for_timeout(800)
    pg.screenshot(path=S+'z_settings.png',full_page=True)
    sel=pg.locator('select').filter(has=pg.locator('option',has_text='Bill (invoice ready) · Email · English'))
    sel.select_option(label='Bill (invoice ready) · Email · English'); pg.wait_for_timeout(500)
    pg.screenshot(path=S+'z_template.png',full_page=True)
    b.close()
print(errs)
