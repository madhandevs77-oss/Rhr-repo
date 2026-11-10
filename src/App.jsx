import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Spinner, ToastProvider } from './components/common'
import { LOGO, TAGLINE } from './data'
import { AppProvider, useApp } from './store'
import BookingDetail from './screens/BookingDetail'
import BookingRouter from './screens/BookingRouter'
import CalendarScreen from './screens/Calendar'
import MenuManage from './screens/MealMenu'
import MenuPick from './screens/MenuPick'
import Bookings from './screens/Bookings'
import CateringDetail from './screens/CateringDetail'
import CateringForm from './screens/CateringForm'
import Halls from './screens/Halls'
import Home from './screens/Home'
import { InvoiceView, Invoices } from './screens/Invoices'
import Login from './screens/Login'
import { AuditLog, ChangePassword, Customers, FoodMgmt, More, Notifications, PaymentsQueue, Reports, Users, Vendors } from './screens/Admin'
import Settings from './screens/Settings'

const TABS = [
  ['home', 'Home', 'home'],
  ['bookings', 'Bookings', 'list'],
  ['calendar', 'Calendar', 'cal'],
  ['menuPick', 'Menu', 'food'],
  ['more', 'More', 'more'],
]
const TITLES = {
  form: 'Hall Booking', detail: 'Hall Booking', cForm: 'New Order', cDetail: 'Order', customers: 'Customers', halls: 'Manage Halls', foodMgmt: 'Catering Prices', mealMenu: 'Catering Menu', calendarSec: 'Calendar', secHistory: 'Section History',
  reports: 'Reports', audit: 'Audit Log', settings: 'Settings', invoices: 'Invoices', invoice: 'Invoice', payments: 'Payments to Verify', notifications: 'Messages', vendors: 'Vendors', users: 'Users', password: 'Change Password',
}

function Shell() {
  const { settings, user, can, logout } = useApp()
  const [stack, setStack] = useState([{ name: 'home' }])
  const [menu, setMenu] = useState(false)
  const cur = stack[stack.length - 1]
  const nav = {
    go: (name, params = {}) => setStack((s) => [...s, { name, ...params }]),
    replace: (name, params = {}) => setStack((s) => [...s.slice(0, -1), { name, ...params }]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    tab: (name) => setStack([{ name }]),
  }
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [cur])
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menu) return undefined
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false) }
    const esc = (e) => e.key === 'Escape' && setMenu(false)
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc) }
  }, [menu])

  const activeTab = stack[0].name
  const isSub = stack.length > 1

  let screen
  switch (cur.name) {
    case 'home': screen = <Home nav={nav} />; break
    case 'bookings': screen = <Bookings nav={nav} />; break
    case 'secHistory': screen = <Bookings nav={nav} hallId={cur.hallId} key={cur.hallId} />; break
    case 'calendar': screen = <CalendarScreen nav={nav} />; break
    case 'calendarSec': screen = <CalendarScreen nav={nav} hallId={cur.hallId} key={cur.hallId} />; break
    case 'mealMenu': screen = <MenuManage nav={nav} />; break
    case 'menuPick': screen = <MenuPick nav={nav} />; break
    case 'more': screen = <More nav={nav} />; break
    case 'detail': screen = <BookingDetail nav={nav} id={cur.id} key={cur.id} />; break
    case 'form': screen = <BookingRouter nav={nav} id={cur.id} hallId={cur.hallId} draftId={cur.draftId} key={(cur.id || 'new') + (cur.hallId || '') + (cur.draftId || '')} />; break
    case 'cDetail': screen = <CateringDetail nav={nav} id={cur.id} key={cur.id} />; break
    case 'cForm': screen = <CateringForm nav={nav} id={cur.id} bookingId={cur.bookingId} draftId={cur.draftId} key={(cur.id || 'new') + (cur.draftId || '')} />; break
    case 'invoices': screen = <Invoices nav={nav} />; break
    case 'invoice': screen = <InvoiceView nav={nav} id={cur.id} autoPrint={cur.autoPrint} key={cur.id} />; break
    case 'payments': screen = <PaymentsQueue nav={nav} />; break
    case 'notifications': screen = <Notifications nav={nav} />; break
    case 'customers': screen = <Customers nav={nav} />; break
    case 'halls': screen = <Halls openHall={cur.hallId} openTab={cur.tab} key={(cur.hallId || '') + (cur.tab || '')} />; break
    case 'foodMgmt': screen = <FoodMgmt nav={nav} />; break
    case 'vendors': screen = <Vendors />; break
    case 'users': screen = <Users />; break
    case 'reports': screen = <Reports />; break
    case 'audit': screen = <AuditLog />; break
    case 'settings': screen = <Settings />; break
    case 'password': screen = <ChangePassword onDone={nav.back} />; break
    default: screen = null
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header__left">
          {isSub && (
            <button className="header__back" onClick={nav.back} aria-label="Back"><Icon name="back" size={24} /></button>
          )}
          <div className="header__brand">
            {!isSub && <img className="header__logo" src={LOGO} alt="RHR logo" style={{ borderRadius: '50%', objectFit: 'cover' }} />}
            <span className="header__title">{isSub ? TITLES[cur.name] : settings.business.name}</span>
          </div>
        </div>
        <div className="header__right" ref={menuRef}>
          {can('halls.manage') && (
            <button className="header__pill" onClick={() => nav.go('halls')} aria-label="Manage halls" data-testid="manage-halls">
              <Icon name="home" size={16} /><span>Halls</span>
            </button>
          )}
          <button className="header__avatar" onClick={() => setMenu((v) => !v)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu" title={`${user.name} (${user.role})`}>
            {user.name.trim()[0]?.toUpperCase()}
          </button>
          {menu && (
            <div className="account-menu" role="menu">
              <div className="account-menu__who"><strong>{user.name}</strong><span>{user.role}</span></div>
              {can('halls.manage') && <button role="menuitem" onClick={() => { setMenu(false); nav.go('halls') }}>Manage Halls</button>}
              <button role="menuitem" onClick={() => { setMenu(false); nav.go('password') }}>Change password</button>
              <button role="menuitem" onClick={logout}>Sign out</button>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        <section className="screen active" key={cur.name + (cur.id || '')}>{screen}</section>
      </main>

      <nav className="bottom-nav">
        {TABS.map(([k, label, icon]) => (
          <button key={k} className={`bottom-nav__item ${activeTab === k ? 'active' : ''}`} onClick={() => nav.tab(k)}>
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

function Splash({ done }) {
  const [out, setOut] = useState(false)
  useEffect(() => {
    const a = setTimeout(() => setOut(true), 900)
    const b = setTimeout(done, 1300)
    return () => { clearTimeout(a); clearTimeout(b) }
  }, [done])
  return (
    <div className={`splash ${out ? 'fade-out' : ''}`}>
      <div className="splash__content">
        <div className="splash__logo"><img src={LOGO} alt="RHR logo" style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} /></div>
        <h1 className="splash__name">RHR Veg Restaurant</h1>
        <p className="splash__tagline">{TAGLINE}</p>
        <div className="splash__loader"><div className="splash__loader-bar" /></div>
      </div>
    </div>
  )
}

function Gate() {
  const { user } = useApp()
  if (user === undefined) return <div className="gate"><Spinner label="Starting…" /></div>
  if (user === null) return <Login />
  return <Shell key={user.id} />
}

export default function App() {
  const [splash, setSplash] = useState(true)
  const done = useCallback(() => setSplash(false), [])
  return (
    <ToastProvider>
      <AppProvider>
        <Gate />
        {splash && <Splash done={done} />}
      </AppProvider>
    </ToastProvider>
  )
}
