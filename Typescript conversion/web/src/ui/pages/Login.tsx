import React, { useState } from 'react'

export default function Login() {
  const [email, setEmail] = useState('')
  const [pwd, setPwd] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e?: React.FormEvent) {
    try { if (e) e.preventDefault() } catch {}
    try {
      setBusy(true); setMsg('Working...')
      const r = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pwd }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return setMsg('Error: ' + (j.error || r.status))
      setMsg('Success! Redirecting...')
      setTimeout(() => { location.href = '/' }, 600)
    } catch (e: any) {
      setMsg('Error: ' + (e?.message || 'unknown'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <canvas id="bg"></canvas>
      <form className="card" onSubmit={submit}>
        <h2>Welcome back</h2>
        <p className="sub">Sign in to continue to your AI companion.</p>
        <input placeholder="Email" value={email} onChange={(e)=>setEmail(e.target.value)} />
        <input placeholder="Password" type="password" value={pwd} onChange={(e)=>setPwd(e.target.value)} />
        <button type="submit" disabled={busy}>Sign in</button>
        <p className="muted center">Don't have an account? <a href="/signup">Create one</a></p>
        <div id="msg">{msg}</div>
      </form>
    </>
  )
}


