import { useState } from 'react'
import { errMsg } from '../api'
import { LOGO, TAGLINE } from '../data'
import { useApp } from '../store'

export default function Login() {
  const { login } = useApp()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      await login(u.trim(), p)
    } catch (x) {
      setErr(errMsg(x))
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <img className="login__logo" src={LOGO} alt="RHR logo" />
        <h1>RHR Veg Restaurant</h1>
        <p className="login__tag">{TAGLINE}</p>
        <label htmlFor="lu">Username</label>
        <input id="lu" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
        <label htmlFor="lp">Password</label>
        <input id="lp" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" required />
        {err && <div className="form-error" role="alert">{err}</div>}
        <button className="btn btn--primary btn--block btn--large" disabled={busy || !u || !p}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="login__hint">Staff accounts are created by the administrator.</p>
      </form>
    </div>
  )
}
