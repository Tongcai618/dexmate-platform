import { useState } from 'react'
import { act, api, useApi } from '../lib/api'
import type { Topic, User } from '../lib/types'

export default function Forum({ user }: { user: User }) {
  const { data: topics, setData: setTopics, error: loadError } = useApi<Topic[]>('/topics')
  const [openId, setOpenId] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')

  const open = topics?.find((t) => t.id === openId)

  // Every forum mutation returns the updated topic.
  const mutate = (fn: () => Promise<Topic>) =>
    act(setError, async () => {
      const t = await fn()
      setTopics((prev) => (prev ?? []).map((x) => (x.id === t.id ? t : x)))
    })

  function postReply() {
    if (!open || !reply.trim()) return
    mutate(async () => {
      const t = await api<Topic>(`/topics/${open.id}/replies`, { body: { body: reply.trim() } })
      setReply('')
      return t
    })
  }

  function openTopic(id: string | null) {
    setOpenId(id)
    setError('')
  }

  if (!open) {
    return (
      <>
        <header className="page-head">
          <h1>Forum</h1>
          <p className="muted">Community Q&A. Accepted answers and votes also become labeled training data for the knowledge base and models.</p>
        </header>
        <section className="card">
          {loadError && <div className="error">{loadError}</div>}
          {(topics ?? []).map((t) => (
            <button key={t.id} className="topic" onClick={() => openTopic(t.id)}>
              <span className="pill">{t.category}</span>
              <span className="topic-title">{t.title}</span>
              {t.replies.some((r) => r.accepted) && <span className="badge ok">solved</span>}
              <span className="muted small">{t.replies.length} replies</span>
            </button>
          ))}
        </section>
      </>
    )
  }

  return (
    <>
      <button className="link" onClick={() => openTopic(null)}>← All topics</button>
      <header className="page-head">
        <h1>{open.title}</h1>
        <p className="muted"><span className="pill">{open.category}</span> by {open.author}</p>
      </header>

      {open.replies.map((r) => (
        <section key={r.id} className={r.accepted ? 'card reply accepted' : 'card reply'}>
          <div className="votes-col">
            <button className="link" disabled={r.voted} title={r.voted ? 'You upvoted this' : 'Upvote'} onClick={() => mutate(() => api<Topic>(`/replies/${r.id}/vote`, { method: 'POST' }))}>▲</button>
            <b>{r.votes}</b>
          </div>
          <div className="grow">
            <div className="small"><b>{r.author}</b> {r.accepted && <span className="badge ok">✓ accepted</span>}</div>
            <p>{r.body}</p>
            {open.author === user.id && !r.accepted && (
              <button className="link" onClick={() => mutate(() => api<Topic>(`/replies/${r.id}/accept`, { method: 'POST' }))}>Mark as solution</button>
            )}
          </div>
        </section>
      ))}

      <section className="card">
        <textarea rows={3} placeholder="Write a reply…" value={reply} onChange={(e) => setReply(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <div className="row"><button className="primary" onClick={postReply}>Reply</button></div>
      </section>
    </>
  )
}
