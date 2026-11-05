import json, datetime, struct, zlib
from playwright.sync_api import sync_playwright
D='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
S=D+'shots/'
def png(path,w=900,h=600):
    raw=b''.join(b'\x00'+bytes([(x*7)%256,(y*3)%256,120])*1 * 1 for y in range(h) for x in range(0)) # placeholder
    rows=b''.join(b'\x00'+b''.join(bytes([(x*5)%256,(y*4)%256,150]) for x in range(w)) for y in range(h))
    def ch(t,d): 
        c=struct.pack('>I',len(d))+t+d; return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    open(path,'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(rows))+ch(b'IEND',b''))
png(D+'t1.png'); png(D+'t2.png',1000,700)
date=(datetime.date.today()+datetime.timedelta(days=40)).isoformat()
errs=[]; log=[]
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':390,'height':800}, accept_downloads=True)
    pg=ctx.new_page()
    pg.on('pageerror',lambda e:errs.append(('pageerror',str(e))))
    pg.on('console',lambda m: errs.append(('console',m.text)) if m.type=='error' else None)
    pg.on('response',lambda r: errs.append(('http',r.status,r.url)) if r.status>=400 else None)
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
    i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
    pg.wait_for_selector('[data-testid=manage-halls]')
    # --- hall photo upload
    pg.click('[data-testid=manage-halls]'); pg.wait_for_timeout(500)
    pg.locator('.hall-manage-card button[aria-label*="dit"], .hall-manage-card button').first.click(); pg.wait_for_timeout(600)
    pg.screenshot(path=S+'u_hall_edit.png')
    pg.get_by_text('Photos',exact=True).first.click(); pg.wait_for_timeout(400)
    pg.set_input_files('[data-testid=hall-file-input]',[D+'t1.png',D+'t2.png']); pg.wait_for_timeout(500)
    pg.screenshot(path=S+'u_staged.png')
    pg.click('[data-testid=upload-btn]'); pg.wait_for_timeout(2500)
    pg.screenshot(path=S+'u_uploaded.png')
    log.append('photos in list: %d'%pg.locator('.photo-card').count())
    # --- new booking
    pg.goto('http://localhost:3001/'); pg.get_by_text('New Booking').first.wait_for()
    pg.get_by_text('New Booking').first.click(); pg.wait_for_timeout(800); pg.screenshot(path=S+'u_newbooking.png')
    pg.get_by_placeholder('Full name').fill('Test Customer'); pg.get_by_placeholder('10-digit mobile').fill('9876500011')
    pg.locator('.consent input').first.check()
    pg.get_by_role('button',name='Next',exact=False).click(); pg.wait_for_timeout(400)
    pg.locator('select').first.select_option(index=1)
    pg.locator('input[type=date]').fill(date)
    pg.locator('input[type=time]').nth(0).fill('10:00'); pg.locator('input[type=time]').nth(1).fill('14:00')
    pg.locator('.hall-pick').first.click(); pg.wait_for_timeout(600)
    pg.get_by_placeholder('Expected guests').fill('80')
    pg.screenshot(path=S+'u_form2.png')
    pg.get_by_role('button',name='Next',exact=False).click(); pg.wait_for_timeout(400)
    pg.locator('input[type=number]').first.fill('10000')
    pg.get_by_placeholder('0').first.fill('10000')
    pg.screenshot(path=S+'u_form3.png')
    pg.get_by_role('button',name='Next',exact=False).click(); pg.wait_for_timeout(400)
    pg.screenshot(path=S+'u_form4.png')
    for _ in range(3):
        if pg.get_by_role('button',name='Save Booking').count(): break
        pg.get_by_role('button',name='Next',exact=False).click(); pg.wait_for_timeout(300)
    pg.get_by_role('button',name='Save Booking').click(); pg.wait_for_timeout(1500)
    pg.screenshot(path=S+'u_detail.png', full_page=True)
    log.append('detail url text: '+pg.locator('.booking-detail__ref, h2').first.inner_text())
    b.close()
print(json.dumps(log,indent=1)); print(json.dumps(errs,indent=1))
