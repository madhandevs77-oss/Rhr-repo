import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, setUnauthorizedHandler } from './api'

const Ctx = createContext(null)
export const useApp = () => useContext(Ctx)

/** Session + the small, widely-shared reference data (halls, business info, catering options). Everything else is fetched per screen. */
export function AppProvider({ children }) {
  const [user, setUser] = useState(undefined) // undefined = checking, null = signed out
  const [halls, setHalls] = useState([])
  const [settings, setSettings] = useState({ business: { name: 'RHR Veg Restaurant', phone: '', address: '' }, finance: { taxLabel: 'GST', defaultTaxRate: 0 } })
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

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    api.get('/api/auth/me').then((r) => setUser(r.user), () => setUser(null))
  }, [])
  useEffect(() => {
    if (user) loadRef().catch(() => {})
  }, [user, loadRef])

  const login = useCallback(async (username, password) => {
    const r = await api.post('/api/auth/login', { username, password })
    setUser(r.user)
  }, [])
  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout') } catch { /* cookie is cleared client-side by the 401 handler anyway */ }
    setUser(null)
    setHalls([])
    setPicked([])
  }, [])

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
