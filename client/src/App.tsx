import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '')

type Source = {
  title?: string
  url: string
  site_name?: string
  snippet?: string
  date?: string
  status?: 'validated' | 'unverified' | 'excluded'
}
type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  model?: string
  created_at?: string
}
type Conversation = {
  id: string
  title?: string
  created_at?: string
  updated_at?: string
  message_count?: number
}
type ConversationMessage = {
  id?: string
  role: string
  content: string
  created_at?: string
  metadata?: string | Record<string, unknown>
}
type AgentResponse = {
  success?: boolean
  data?: {
    conversationId?: string
    answer?: string
    model?: string
    sources?: Source[]
    validatedSources?: Source[]
  }
  conversationId?: string
  answer?: string
  model?: string
  sources?: Source[]
  validatedSources?: Source[]
  message?: string
  error?: string
}
type MemoryFact = {
  id: string
  fact_type?: 'shortlist' | 'decision' | string
  subject?: string
  predicate?: string
  object?: string
  status?: 'current' | 'superseded' | string
  source_content?: string
  observed_at?: string
  conversation_title?: string
  supersession_reason?: string
}
type MemoryTab = 'facts' | 'search' | 'timeline'
type ConnectionState = 'checking' | 'connected' | 'offline'

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = result?.error
    throw new Error(typeof error === 'string' ? error : result?.message || `Request failed (${response.status})`)
  }
  return result as T
}
function getPayload<T>(response: unknown): T {
  const result = response as { data?: T }
  return (result?.data ?? response) as T
}
function safeSources(data: { validatedSources?: Source[]; sources?: Source[] }): Source[] {
  const candidates = data.validatedSources ?? data.sources ?? []
  return candidates.filter((source) =>
    source && typeof source.url === 'string' && /^https?:\/\//i.test(source.url) && source.status !== 'excluded',
  )
}
function formatDate(date?: string) {
  if (!date) return ''
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function formatDateTime(date?: string) {
  if (!date) return ''
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString()
}
function MarkdownAnswer({ content }: { content: string }) {
  const normalizedContent = content.replace(/\\([*_`~#[\]()])/g, '$1')
  return (
    <div className="markdown-answer">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <>{children}</>,
        table: ({ children }) => <div className="markdown-table-wrapper"><table>{children}</table></div>,
      }}>{normalizedContent}</ReactMarkdown>
    </div>
  )
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [openingConversation, setOpeningConversation] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState<ConnectionState>('checking')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memoryTab, setMemoryTab] = useState<MemoryTab>('facts')
  const [facts, setFacts] = useState<MemoryFact[]>([])
  const [factStatus, setFactStatus] = useState('current')
  const [factType, setFactType] = useState('')
  const [factsLoading, setFactsLoading] = useState(false)
  const [memoryQuery, setMemoryQuery] = useState('')
  const [memoryResults, setMemoryResults] = useState<any[]>([])
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [timelineWhen, setTimelineWhen] = useState('today')
  const [timelineResult, setTimelineResult] = useState<any>(null)
  const [memoryError, setMemoryError] = useState('')
  const [memoryNotice, setMemoryNotice] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeConversationRef = useRef<string | null>(null)
  const requestVersionRef = useRef(0)
  useEffect(() => { activeConversationRef.current = activeConversationId }, [activeConversationId])

  const loadConversations = useCallback(async () => {
    try {
      const response = await apiRequest<unknown>('/conversations')
      const payload = getPayload<unknown>(response)
      const list = Array.isArray(payload) ? payload : (payload as { conversations?: Conversation[] })?.conversations ?? []
      setConversations(list as Conversation[])
    } catch (err) {
      console.error('Unable to load conversations:', err)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    try {
      await apiRequest('/health')
      setConnection('connected')
    } catch {
      setConnection('offline')
    }
  }, [])

  useEffect(() => { void loadConversations(); void checkConnection() }, [loadConversations, checkConnection])
  useEffect(() => {
    const interval = window.setInterval(() => { void checkConnection() }, 30000)
    return () => window.clearInterval(interval)
  }, [checkConnection])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  const startNewChat = () => {
    if (loading || openingConversation) return
    requestVersionRef.current += 1
    setActiveConversationId(null)
    activeConversationRef.current = null
    setMessages([])
    setInput('')
    setError('')
    setSidebarOpen(false)
    inputRef.current?.focus()
  }

  const openConversation = async (id: string) => {
    if (loading || openingConversation || id === activeConversationId) return
    const version = ++requestVersionRef.current
    setOpeningConversation(true)
    setActiveConversationId(id)
    activeConversationRef.current = id
    setMessages([])
    setError('')
    setSidebarOpen(false)
    try {
      const response = await apiRequest<unknown>(`/conversations/${encodeURIComponent(id)}`)
      if (version !== requestVersionRef.current) return
      const payload = getPayload<{ messages?: ConversationMessage[]; conversation?: { messages?: ConversationMessage[] } }>(response)
      const rows = payload.messages ?? payload.conversation?.messages ?? []
      const formatted: Message[] = rows
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .map((item, index) => {
          let metadata: Record<string, unknown> = {}
          if (typeof item.metadata === 'string') {
            try { metadata = JSON.parse(item.metadata) } catch { metadata = {} }
          } else if (item.metadata) metadata = item.metadata
          const savedSources = (metadata.validatedSources as Source[] | undefined) ?? (metadata.sources as Source[] | undefined) ?? []
          return {
            id: item.id ?? `${id}-${index}`,
            role: item.role as 'user' | 'assistant',
            content: item.content,
            created_at: item.created_at,
            sources: safeSources({ sources: savedSources }),
            model: typeof metadata.model === 'string' ? metadata.model : undefined,
          }
        })
      setMessages(formatted)
    } catch (err) {
      if (version === requestVersionRef.current) setError(err instanceof Error ? err.message : 'Unable to load conversation.')
    } finally {
      if (version === requestVersionRef.current) setOpeningConversation(false)
    }
  }

  const sendMessage = async () => {
    const message = input.trim()
    if (!message || loading || openingConversation) return
    const version = requestVersionRef.current
    const conversationIdAtSend = activeConversationRef.current
    setError('')
    setInput('')
    setLoading(true)
    const userMessage: Message = { id: `user-${Date.now()}`, role: 'user', content: message }
    setMessages((previous) => [...previous, userMessage])
    try {
      const response = await apiRequest<AgentResponse>('/agent/chat', {
        method: 'POST',
        body: JSON.stringify({ message, ...(conversationIdAtSend ? { conversationId: conversationIdAtSend } : {}) }),
      })
      const data = response.data ?? response
      if (!data.answer) throw new Error(response.message || response.error || 'The agent returned an empty response.')
      if (version !== requestVersionRef.current) return
      if (data.conversationId) {
        setActiveConversationId(data.conversationId)
        activeConversationRef.current = data.conversationId
      }
      setMessages((previous) => [...previous, {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.answer!,
        sources: safeSources(data),
        model: data.model,
      }])
      await loadConversations()
    } catch (err) {
      if (version === requestVersionRef.current) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
        setMessages((previous) => previous.filter((item) => item.id !== userMessage.id))
        setInput(message)
      }
    } finally {
      if (version === requestVersionRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        startNewChat()
      }
      if (event.key === 'Escape') { setMemoryOpen(false); setSidebarOpen(false) }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  })

  const loadFacts = async () => {
    setFactsLoading(true); setMemoryError(''); setMemoryNotice('')
    try {
      const params = new URLSearchParams({ status: factStatus, limit: '100' })
      if (factType) params.set('type', factType)
      const response = await apiRequest<unknown>(`/memory/facts?${params}`)
      const payload = getPayload<unknown>(response)
      setFacts(Array.isArray(payload) ? payload as MemoryFact[] : [])
    } catch (err) { setMemoryError(err instanceof Error ? err.message : 'Unable to load saved facts.') }
    finally { setFactsLoading(false) }
  }
  useEffect(() => { if (memoryOpen && memoryTab === 'facts') void loadFacts() }, [memoryOpen, memoryTab, factStatus, factType])

  const searchMemory = async () => {
    if (!memoryQuery.trim()) return
    setMemoryBusy(true); setMemoryError(''); setMemoryNotice('')
    try {
      const params = new URLSearchParams({ q: memoryQuery.trim(), limit: '30' })
      const response = await apiRequest<unknown>(`/memory/search?${params}`)
      const payload = getPayload<unknown>(response)
      setMemoryResults(Array.isArray(payload) ? payload : [])
    } catch (err) { setMemoryError(err instanceof Error ? err.message : 'Unable to search history.') }
    finally { setMemoryBusy(false) }
  }
  const searchTimeline = async () => {
    if (!timelineWhen.trim()) return
    setMemoryBusy(true); setMemoryError(''); setMemoryNotice('')
    try {
      const params = new URLSearchParams({ when: timelineWhen.trim() })
      const response = await apiRequest<unknown>(`/memory/timeline?${params}`)
      setTimelineResult(getPayload<unknown>(response))
    } catch (err) { setMemoryError(err instanceof Error ? err.message : 'Unable to retrieve timeline.') }
    finally { setMemoryBusy(false) }
  }
  const extractMemory = async () => {
    if (!activeConversationId) { setMemoryError('Open a conversation first to extract facts from it.'); return }
    setMemoryBusy(true); setMemoryError(''); setMemoryNotice('')
    try {
      const response = await apiRequest<unknown>(`/memory/${encodeURIComponent(activeConversationId)}/extract`, { method: 'POST' })
      const payload = getPayload<any>(response)
      setMemoryNotice(`Extraction completed${typeof payload?.count === 'number' ? ` · ${payload.count} facts processed` : ''}.`)
      await loadFacts()
    } catch (err) { setMemoryError(err instanceof Error ? err.message : 'Memory extraction failed.') }
    finally { setMemoryBusy(false) }
  }
  const supersedeFact = async (fact: MemoryFact) => {
    const reason = window.prompt('Why is this fact no longer current?')
    if (!reason?.trim()) return
    setMemoryBusy(true); setMemoryError(''); setMemoryNotice('')
    try {
      await apiRequest(`/memory/facts/${encodeURIComponent(fact.id)}/supersede`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      })
      setMemoryNotice('Fact marked as superseded.')
      await loadFacts()
    } catch (err) { setMemoryError(err instanceof Error ? err.message : 'Unable to update this fact.') }
    finally { setMemoryBusy(false) }
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage() }
  }
  const copyAnswer = async (content: string) => {
    try { await navigator.clipboard.writeText(content); setError('Answer copied to clipboard.') }
    catch { setError('Could not access clipboard. Select the answer and copy it manually.') }
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-overlay" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <button className="brand" onClick={startNewChat} aria-label="Minimi home"><span className="brand-mark">m</span><span>minimi</span></button>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">×</button>
        </div>
        <button className="new-chat-button" onClick={startNewChat} disabled={loading || openingConversation}><span>＋</span>New chat<kbd>⌘ K</kbd></button>
        <button className="memory-launch" onClick={() => { setMemoryOpen(true); setSidebarOpen(false) }}><span>◈</span> Memory & history <span className="memory-launch-arrow">↗</span></button>
        <div className="history-section">
          <div className="section-label">YOUR CHATS</div>
          {historyLoading ? <div className="history-message">Loading conversations...</div> : conversations.length === 0 ? <div className="history-message">Your conversations will appear here.</div> : (
            <div className="conversation-list">
              {conversations.map((conversation) => <button key={conversation.id} className={`conversation-item ${activeConversationId === conversation.id ? 'active' : ''}`} onClick={() => void openConversation(conversation.id)} disabled={loading || openingConversation} title={conversation.title || 'Conversation'}>
                <span className="conversation-icon">◷</span><span className="conversation-title">{conversation.title || 'New conversation'}</span><span className="conversation-date">{formatDate(conversation.updated_at || conversation.created_at)}</span>
              </button>)}
            </div>
          )}
        </div>
        <div className="sidebar-footer"><div className={`status-dot ${connection === 'offline' ? 'offline' : ''}`} /><div><div className="status-title">{connection === 'checking' ? 'Checking API' : connection === 'connected' ? 'Agent online' : 'API offline'}</div><div className="status-subtitle">Web search enabled</div></div><span className="version-label">BETA</span></div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">☰</button><span className="topbar-title">Workspace</span><span className="topbar-divider">/</span><span className="topbar-current">AI Assistant</span></div>
          <div className="topbar-right"><button className="topbar-memory-button" onClick={() => setMemoryOpen(true)}>◈ <span>Memory</span></button><span className={`connection-indicator ${connection}`}><span />{connection === 'checking' ? 'Checking' : connection === 'connected' ? 'Connected' : 'Disconnected'}</span><div className="avatar">M</div></div>
        </header>

        <section className="chat-area">
          {openingConversation ? <div className="chat-loading">Loading conversation…</div> : messages.length === 0 ? (
            <div className="welcome-screen"><div className="welcome-icon"><span>✳</span></div><div className="eyebrow">YOUR WEB RESEARCH ASSISTANT</div><h1>What can I help you <span>discover?</span></h1><p className="welcome-description">Ask anything. Minimi searches the web, checks sources, and brings the useful information together.</p>
              <div className="suggestion-grid">
                <button className="suggestion-card" onClick={() => setInput('What are the latest developments in artificial intelligence?')}><span className="suggestion-icon purple">✳</span><span><strong>Latest AI developments</strong><small>Explore recent news and announcements</small></span><span className="suggestion-arrow">↗</span></button>
                <button className="suggestion-card" onClick={() => setInput('Compare the latest React and Vue features.')}><span className="suggestion-icon blue">⌘</span><span><strong>Compare technologies</strong><small>Research tools and understand differences</small></span><span className="suggestion-arrow">↗</span></button>
                <button className="suggestion-card" onClick={() => setInput('Find recent announcements from major technology companies.')}><span className="suggestion-icon orange">◷</span><span><strong>Track announcements</strong><small>Find what changed recently</small></span><span className="suggestion-arrow">↗</span></button>
                <button className="suggestion-card" onClick={() => setInput('Research the latest trends in IoT and edge computing.')}><span className="suggestion-icon green">⌁</span><span><strong>Research a topic</strong><small>Get useful information from the web</small></span><span className="suggestion-arrow">↗</span></button>
              </div>
            </div>
          ) : (
            <div className="messages-container">
              {messages.map((message) => <article className={`message-row ${message.role}`} key={message.id}>
                <div className={`message-avatar ${message.role}`}>{message.role === 'user' ? 'Y' : 'm'}</div>
                <div className="message-content"><div className="message-author">{message.role === 'user' ? 'You' : 'Minimi'}{message.model && message.role === 'assistant' && <span className="model-label">{message.model}</span>}</div>
                  <div className="message-text">{message.role === 'assistant' ? <MarkdownAnswer content={message.content} /> : <p>{message.content}</p>}</div>
                  {message.role === 'assistant' && <button className="copy-answer-button" onClick={() => void copyAnswer(message.content)}>▢ Copy answer</button>}
                  {message.sources && message.sources.length > 0 && <div className="sources-panel"><div className="sources-heading"><span>↗</span> Sources <span className="source-count">{message.sources.length}</span></div><div className="sources-list">{message.sources.map((source, index) => <a className="source-card" href={source.url} target="_blank" rel="noopener noreferrer" key={`${source.url}-${index}`}><span className="source-number">{index + 1}</span><span className="source-details"><strong>{source.title || source.site_name || source.url}</strong><small>{source.site_name || source.url}</small>{source.date && <small>{source.date}</small>}{source.snippet && <span>{source.snippet}</span>}{source.status === 'unverified' && <small className="source-unverified">Not independently verified</small>}</span><span className="source-external">↗</span></a>)}</div></div>}
                </div>
              </article>)}
              {loading && <div className="message-row assistant"><div className="message-avatar assistant">m</div><div className="message-content"><div className="message-author">Minimi</div><div className="thinking-indicator"><span /><span /><span /><small>Searching and thinking...</small></div></div></div>}
              <div ref={messagesEndRef} />
            </div>
          )}
        </section>

        <footer className="composer-area">
          {error && <div className="error-message"><span>⚠</span>{error}<button onClick={() => setError('')} aria-label="Dismiss message">×</button></div>}
          <div className="composer"><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} placeholder="Ask Minimi anything..." rows={1} disabled={loading || openingConversation} /><div className="composer-bottom"><div className="composer-hint"><span className="search-hint-icon">⌕</span>Web search enabled<span className="hint-divider">·</span><span>Enter to send</span></div><button className="send-button" onClick={() => void sendMessage()} disabled={!input.trim() || loading || openingConversation} aria-label="Send message">{loading ? '…' : '↑'}</button></div></div>
          <p className="disclaimer">Minimi can make mistakes. Check important information against its sources.</p>
        </footer>
      </main>

      {memoryOpen && <div className="memory-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMemoryOpen(false) }}>
        <section className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-title">
          <header className="memory-header"><div><div className="memory-eyebrow">MINIMI MEMORY</div><h2 id="memory-title">Memory & history</h2><p>Explore facts and information saved from your conversations.</p></div><button className="memory-close" onClick={() => setMemoryOpen(false)} aria-label="Close memory">×</button></header>
          <nav className="memory-tabs"><button className={memoryTab === 'facts' ? 'active' : ''} onClick={() => setMemoryTab('facts')}>Saved facts</button><button className={memoryTab === 'search' ? 'active' : ''} onClick={() => setMemoryTab('search')}>Search history</button><button className={memoryTab === 'timeline' ? 'active' : ''} onClick={() => setMemoryTab('timeline')}>Timeline</button></nav>
          {memoryError && <div className="memory-alert error">{memoryError}</div>}{memoryNotice && <div className="memory-alert success">{memoryNotice}</div>}
          <div className="memory-content">
            {memoryTab === 'facts' && <>
              <div className="memory-toolbar"><select value={factStatus} onChange={(event) => setFactStatus(event.target.value)}><option value="current">Current facts</option><option value="superseded">Superseded facts</option><option value="all">All facts</option></select><select value={factType} onChange={(event) => setFactType(event.target.value)}><option value="">All types</option><option value="shortlist">Shortlists</option><option value="decision">Decisions</option></select></div>
              <div className="memory-action-row"><span>Facts extracted from your chats</span><button onClick={() => void extractMemory()} disabled={memoryBusy || !activeConversationId}>{memoryBusy ? 'Working…' : '＋ Extract from open chat'}</button></div>
              {!activeConversationId && <p className="memory-hint">Open a conversation to extract facts from it.</p>}
              {factsLoading ? <div className="memory-empty">Loading saved facts…</div> : facts.length === 0 ? <div className="memory-empty">No facts found for this filter.</div> : facts.map((fact) => <article className="fact-card" key={fact.id}><div className="fact-card-top"><span className="fact-type">{fact.fact_type || 'FACT'}</span><span className={`fact-status ${fact.status || 'current'}`}>{fact.status || 'current'}</span></div><h3>{fact.subject || 'Saved fact'}</h3><p className="fact-statement">{fact.predicate ? `${fact.predicate} ` : ''}{fact.object || ''}</p>{fact.source_content && <details><summary>Original context</summary><p>{fact.source_content}</p></details>}<div className="fact-meta">{fact.conversation_title || 'Conversation'}{fact.observed_at ? ` · ${formatDateTime(fact.observed_at)}` : ''}</div>{fact.status !== 'superseded' && <button className="supersede-button" disabled={memoryBusy} onClick={() => void supersedeFact(fact)}>Mark as outdated</button>}</article>)}
            </>}
            {memoryTab === 'search' && <><form className="memory-search-form" onSubmit={(event) => { event.preventDefault(); void searchMemory() }}><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="Search words from past conversations…" /><button disabled={memoryBusy || !memoryQuery.trim()}>{memoryBusy ? 'Searching…' : 'Search'}</button></form>{memoryResults.length === 0 ? <div className="memory-empty">Search your previous messages by keyword.</div> : memoryResults.map((item, index) => <article className="history-result-card" key={item.id || index}><div className="fact-meta">{item.role || 'Message'}{item.created_at ? ` · ${formatDateTime(item.created_at)}` : ''}</div><p>{item.content || item.snippet || JSON.stringify(item)}</p>{item.conversation_title && <small>{item.conversation_title}</small>}</article>)}</>}
            {memoryTab === 'timeline' && <><form className="memory-search-form" onSubmit={(event) => { event.preventDefault(); void searchTimeline() }}><input value={timelineWhen} onChange={(event) => setTimelineWhen(event.target.value)} placeholder="today, yesterday, last week…" /><button disabled={memoryBusy || !timelineWhen.trim()}>{memoryBusy ? 'Loading…' : 'Show timeline'}</button></form><p className="memory-hint">Try: today, yesterday, last week, this week, or a date range.</p>{timelineResult ? <pre className="timeline-result">{JSON.stringify(timelineResult, null, 2)}</pre> : <div className="memory-empty">Choose a time period to view matching conversation activity.</div>}</>}
          </div>
          <footer className="memory-footer">Memory is stored locally in this app's SQLite database.</footer>
        </section>
      </div>}
    </div>
  )
}

export default App
