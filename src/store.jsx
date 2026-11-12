import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api, setUnauthorizedHandler } from './api'

const Ctx = createContext(null)
const DEFAULT_SETTINGS = { business: { name: 'RHR Veg Restaurant', phone: '', address: '' }, finance: { taxLabel: 'GST', defaultTaxRate: 0 } }

/** Ask the service worker (and this page) to drop every cache. Nothing private is stored there, this is defence in depth. */
export function wipeBrowserCaches() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_CACHES' })
    if (typeof caches !== 'undefined') caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
  } catch { /* not supported: nothing to wipe */ }
}
export const useApp = () => useContext(Ctx)

/** Session + the small, widely-shared reference data (halls, business info, catering options). Everything else is fetched per screen. */
export function AppProvider({ children }) {
  const [user, setUser] = useState(undefined) // undefined = checking, null = signed out
  const [halls, setHalls] = useState([])
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [options, setOptions] = useState([])
  // Menu items ticked on the Menu screen (ids of Catering Menu items); they pre-fill the next catering order.
  const [picked, setPicked] = useState([])
  const togglePicked = useCallback((id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])), [])
  const clearPicked = useCallback(() => setPicked([]), [])

  const loadRef = useCallback(async () => {
    const [h, s, o] = await Promise.all([api.get('/api/halls'), api.get('/api/settings'), api.get('/api/catering/options')])
    setHalls(h.halls)
    setSettings(s)
    setOptions(o.options)
  }, [])
  const reloadHalls = useCallback(async () => setHalls((await api.get('/api/halls')).halls), [])
  const reloadSettings = useCallback(async () => setSettings(await api.get('/api/settings')), [])
  const reloadOptions = useCallback(async () => setOptions((await api.get('/api/catering/options')).options), [])

  // Everything that belongs to the signed-in account. Used by logout AND by an expired/invalid session (401).
  const signedIn = useRef(false)
  const resetAccountState = useCallback(() => {
    const was = signedIn.current
    signedIn.current = false
    setUser(null)
    setHalls([])
    setSettings(DEFAULT_SETTINGS)
    setOptions([])
    setPicked([])
    if (was) wipeBrowserCaches()
  }, [])
  useEffect(() => {
    setUnauthorizedHandler(resetAccountState)
    api.get('/api/auth/me').then((r) => { signedIn.current = true; setUser(r.user) }, () => setUser(null))
  }, [resetAccountState])
  useEffect(() => {
    if (user) loadRef().catch(() => {})
  }, [user, loadRef])

  const login = useCallback(async (username, password) => {
    const r = await api.post('/api/auth/login', { username, password })
    signedIn.current = true
    setUser(r.user)
  }, [])
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout') } catch { /* cookie is cleared client-side by the 401 handler anyway */ }
    resetAccountState()
  }, [resetAccountState])

  const can = useCallback((perm) => !!user?.permissions?.includes(perm), [user])
  const value = useMemo(
    () => ({ user, login, logout, can, halls, reloadHalls, settings, reloadSettings, options, reloadOptions, picked, setPicked, togglePicked, clearPicked }),
    [user, login, logout, can, halls, reloadHalls, settings, reloadSettings, options, reloadOptions, picked, togglePicked, clearPicked],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Tiny data-loading hook: { data, error, loading, reload }. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error, loading: false }),
    )
    return () => { live = false }
     
  }, [...deps, tick])
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) }
}
