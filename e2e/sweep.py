import sys
from playwright.sync_api import sync_playwright
users=[('admin','Admin12345x')]
extra=sys.argv[1:]  # optional user:pass
for e in extra: u,pw=e.split(':',1); users.append((u,pw))
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
with sync_playwright() as p:
    b=p.chromium.launch()
    for u,pw in users:
        pg=b.new_context(viewport={'width':390,'height':900}).new_page(); errs=[]
        pg.on('pageerror',lambda e:errs.append('PAGEERR '+str(e))); pg.on('console',lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' and '401' not in m.text and 'Failed to load resource' not in m.text else None)
        pg.on('response',lambda r: errs.append(f'{r.status} {r.url}') if r.status>=400 and 'auth/me' not in r.url else None)
        pg.goto('http://localhost:3001/'); pg.wait_for_selector('input'); i=pg.locator('input'); i.nth(0).fill(u); i.nth(1).fill(pw); pg.click('button:has-text("Sign in")')
        try: pg.wait_for_selector('.bottom-nav',timeout=8000)
        except Exception: print(u,'LOGIN FAILED'); continue
        seen=[]
        def visit(label):
            pg.wait_for_timeout(500); w=pg.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth'); txt=pg.locator('main').inner_text()
            bad=[k for k in ['undefined','NaN','[object','Cannot read','Something went wrong'] if k in txt]
            seen.append((label,w,bad))
        for t in ['Home','Bookings','Calendar','Catering','Menu','More']:
            pg.locator('.bottom-nav button',has_text=t).click(); visit(t)
        pg.locator('.bottom-nav button',has_text='More').click(); n=pg.locator('.more-item').count()
        for k in range(n):
            pg.locator('.bottom-nav button',has_text='More').click(); it=pg.locator('.more-item').nth(k); lab=it.inner_text().split('\n')[0]
            if lab.startswith('Sign out'): continue
            it.click(); visit('More > '+lab)
        pg.locator('.bottom-nav button',has_text='Home').click(); pg.locator('.header__pill').click() if pg.locator('.header__pill').count() else None; visit('Halls manage')
        print('==',u); [print('  ',s) for s in seen if s[1] or s[2]]; print('  screens',len(seen),'errors:',sorted(set(errs)))
    b.close()
