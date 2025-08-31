import React, { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type TranscriptTurn = { role: 'user' | 'assistant'; text: string }

async function getToken() {
  const res = await fetch('/realtime/token')
  if (!res.ok) throw new Error('token failed')
  return res.json() as Promise<{ token: string; instructions?: string; preferredVoice?: string }>
}

export default function App() {
  const [connected, setConnected] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([])
  const [error, setError] = useState<string | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)
  const dcOpenRef = useRef(false)
  const queueRef = useRef<string[]>([])

  const iceServers = useMemo(() => ({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }), [])

  async function connect() {
    setError(null)
    try {
      const tok = await getToken()
      const pc = new RTCPeerConnection(iceServers)
      pcRef.current = pc

      // Data channel for events
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onopen = () => {
        dcOpenRef.current = true
        // Flush any queued messages
        for (const m of queueRef.current.splice(0)) dc.send(m)
        // Apply instructions and elicit a greeting
        if (tok.instructions) {
          dc.send(JSON.stringify({
            type: 'session.update',
            session: { instructions: tok.instructions, voice: tok.preferredVoice || 'alloy', modalities: ['text','audio'] }
          }))
          dc.send(JSON.stringify({ type: 'response.create', response: { modalities: ['text','audio'] } }))
        }
      }
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg?.type === 'response.completed' && msg?.response?.output_text) {
            setTranscript((t) => [...t, { role: 'assistant', text: String(msg.response.output_text) }])
          }
        } catch {}
      }

      // Audio out
      const audio = document.createElement('audio')
      audio.autoplay = true
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0]
      }

      // Mic (optional)
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        for (const track of mic.getTracks()) pc.addTrack(track, mic)
      } catch {}

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const sdpRes = await fetch('/realtime/sdp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          'X-OpenAI-Session-Token': tok.token,
        },
        body: offer.sdp || ''
      })
      const answer = await sdpRes.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })

      setConnected(true)
    } catch (e: any) {
      setError(e?.message || 'connect failed')
    }
  }

  async function sendText(text: string) {
    if (!pcRef.current) return
    setTranscript((t) => [...t, { role: 'user', text }])
    const payloads = [
      JSON.stringify({ type: 'input_text', text }),
      JSON.stringify({ type: 'response.create', response: { modalities: ['text','audio'] } })
    ]
    const dc = dcRef.current
    if (!dc || !dcOpenRef.current || dc.readyState !== 'open') {
      queueRef.current.push(...payloads)
      return
    }
    for (const m of payloads) dc.send(m)
  }

  // Auto-connect on mount
  useEffect(() => { connect() }, [])

  return (
    <div className="app-wrap">
      <header className="app-header">
        <div className="brand">Companion</div>
        <div className={connected ? 'status ok' : 'status'}>{connected ? 'Connected' : 'Connecting…'}</div>
      </header>
      <main className="chat">
        <div className="transcript">
          {transcript.map((t, i) => (
            <div key={i} className={`turn ${t.role}`}><span className="role">{t.role}:</span> {t.text}</div>
          ))}
        </div>
        <Composer onSend={sendText} />
        {error && <div className="error">{error}</div>}
      </main>
    </div>
  )
}

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [val, setVal] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (val.trim()) { onSend(val.trim()); setVal('') } }}>
      <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="Type a message" style={{ width: 320 }} />
      <button type="submit">Send</button>
    </form>
  )
}


