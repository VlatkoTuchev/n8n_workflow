import React, { useState } from 'react'

export default function Signup() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [pwd, setPwd] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e?: React.FormEvent) {
    try { if (e) e.preventDefault() } catch {}
    try {
      setBusy(true); setMsg('Working...')
      const body = { name, email, phone, password: pwd }
      const r = await fetch('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
        <h2>Create your account</h2>
        <p className="sub">Register once. Your profile is linked to your AI identity.</p>
        <input placeholder="Full name" value={name} onChange={(e)=>setName(e.target.value)} />
        <input placeholder="Email" value={email} onChange={(e)=>setEmail(e.target.value)} />
        <input placeholder="Phone (optional)" value={phone} onChange={(e)=>setPhone(e.target.value)} />
        <input placeholder="Password" type="password" value={pwd} onChange={(e)=>setPwd(e.target.value)} />
        <button type="submit" disabled={busy}>Create account</button>
        <p className="muted center">Already have an account? <a href="/login">Sign in</a></p>
        <div id="msg">{msg}</div>
      </form>
    </>
  )
}


