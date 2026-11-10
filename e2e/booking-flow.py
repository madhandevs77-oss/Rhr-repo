# Scenario: create a booking -> verify details -> edit -> cancel -> the slot is free again. Test data only.
import datetime, sys, time
from playwright.sync_api import sync_playwright
S='/tmp/claude-0/-home-claude/3e1dbba9-5760-5a3f-aed0-24db8c232bfc/scratchpad/'
tag=str(int(time.time())%100000); errs=[]
d=(datetime.date.today()+datetime.timedelta(days=500+int(tag)%300)).isoformat()
def login(pg,u,p):
    pg.goto('http://localhost:3001/'); pg.wait_for_selector('input'); i=pg.locator('input'); i.nth(0).fill(u); i.nth(1).fill(p); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('.bottom-nav')
def new_booking(pg,name,phone):
    pg.locator('.bottom-nav button',has_text='Home').click(); pg.wait_for_selector('[data-testid="section-Mini Hall"]')
    pg.locator('[data-testid="section-Mini Hall"] button:has-text("New Booking")').click(); pg.wait_for_selector('.secform')
    pg.get_by_label('Customer name *').fill(name); pg.get_by_label('Contact number *').fill(phone)
    pg.locator('input[type=date]').first.fill(d); pg.locator('input[type=time]').nth(0).fill('10:00'); pg.locator('input[type=time]').nth(1).fill('12:00')
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_context(viewport={'width':390,'height':900}).new_page()
    pg.on('pageerror',lambda e:errs.append(str(e)))
    login(pg,'admin','Admin12345x')
    new_booking(pg,'Flow '+tag,'90000'+tag.zfill(5)); pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_selector('.booking-detail__name')
    body=pg.locator('body').inner_text(); assert 'Flow '+tag in body and 'Mini Hall' in body; ref=pg.locator('.booking-detail__ref').first.inner_text(); print('created',ref)
    # a second booking for the same slot must be refused
    new_booking(pg,'Clash '+tag,'90001'+tag.zfill(5)); pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_selector('.form-error'); print('clash refused:',pg.locator('.form-error').first.inner_text()); assert 'already booked' in pg.locator('.form-error').first.inner_text()
    # open the first booking from the list, edit its notes, save
    pg.locator('.bottom-nav button',has_text='Home').click(); pg.locator('.search-bar__input').fill('Flow '+tag); pg.wait_for_timeout(700); pg.get_by_text('Flow '+tag).first.click(); pg.wait_for_selector('.booking-detail__name')
    pg.get_by_role('button',name='Edit').click(); pg.wait_for_selector('.secform'); pg.get_by_label('Notes').fill('edited by e2e'); pg.get_by_role('button',name='Save changes').click(); pg.wait_for_selector('.booking-detail__name')
    assert 'edited by e2e' in pg.locator('body').inner_text(); print('edit saved')
    # cancel it
    pg.get_by_role('button',name='Cancel Booking').click(); pg.get_by_label('Reason *').fill('e2e cancel'); pg.locator('.modal').get_by_role('button',name='Cancel booking').click(); pg.wait_for_timeout(800)
    assert 'ancelled' in pg.locator('body').inner_text(); print('cancelled')
    # the slot is free again
    new_booking(pg,'Again '+tag,'90002'+tag.zfill(5)); pg.get_by_role('button',name='Save & confirm booking').click(); pg.wait_for_selector('.booking-detail__name'); print('slot re-booked after cancel')
    b.close()
print('page errors:',errs); sys.exit(1 if errs else 0)
