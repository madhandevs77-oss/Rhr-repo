from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/shots/'
res=[];errs=[]
def audit(pg,label):
    r=pg.evaluate("""()=>{const w=window.innerWidth;const de=document.documentElement;
    const bad=[...document.querySelectorAll('.main *')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&(b.right>w+1||b.left<-1)&&getComputedStyle(e).position!=='fixed'&&!e.closest('.lifecycle,.hall-strip,.calendar-scroll,table,.photo-strip')}).slice(0,3).map(e=>e.className||e.tagName);
    return {sw:de.scrollWidth,w,bad}}""")
    if r['sw']>r['w'] or r['bad']: res.append((label,r))
with sync_playwright() as p:
    b=p.chromium.launch()
    for W,H in ((320,640),(390,800),(768,1024),(1280,800)):
        pg=b.new_context(viewport={'width':W,'height':H}).new_page()
        pg.on('pageerror',lambda e:errs.append(str(e)))
        pg.goto('http://localhost:3001/'); pg.wait_for_selector('input')
        i=pg.locator('input'); i.nth(0).fill('admin'); i.nth(1).fill('Admin12345x'); pg.click('button:has-text("Sign in")')
        pg.wait_for_selector('[data-testid=manage-halls]'); pg.wait_for_timeout(500)
        audit(pg,f'{W} home')
        for tab in ['Halls','Catering','Menu','More']:
            pg.locator('.bottom-nav button',has_text=tab).first.click(); pg.wait_for_timeout(600); audit(pg,f'{W} {tab}')
        if W in (390,1280):
            pg.locator('.bottom-nav button',has_text='Menu').first.click(); pg.wait_for_timeout(600)
            boxes=pg.locator('.food-item input[type=checkbox]')
            n=boxes.count(); boxes.nth(0).check(); boxes.nth(1).check(); boxes.nth(2).check()
            pg.screenshot(path=S+f'w{W}_menu.png')
            pg.get_by_role('button',name='Use in catering order').click(); pg.wait_for_timeout(900)
            pg.screenshot(path=S+f'w{W}_catprefill.png',full_page=True)
            print(W,'menu items',n,'prefilled rows',pg.locator('.extras__row--item').count()); audit(pg,f'{W} catform')
        # other screens through More
        for label in ['Invoices','Customers','Halls','Vendors','Reports','Settings']:
            pg.locator('.bottom-nav button',has_text='More').first.click(); pg.wait_for_timeout(300)
            t=pg.locator('.more-item',has_text=label)
            if t.count(): t.first.click(); pg.wait_for_timeout(600); audit(pg,f'{W} {label}')
        pg.close()
    b.close()
print('ISSUES:',res); print('ERRS:',errs)
