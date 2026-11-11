
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import './App.css'

const API_BASE = 'http://localhost:5000/api'

type Source = {
  title?: string
  url: string
  site_name?: string
  snippet?: string
  date?: string
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
}

type AgentResponse = {
  success?: boolean
  data?: {
    conversationId?: string
    answer?: string
    model?: string
    sources?: Source[]
    toolCalls?: unknown[]
    usage?: unknown
  }
  conversationId?: string
  answer?: string
  model?: string
  sources?: Source[]
  message?: string
  error?: string
}

type ConversationMessage = {
  id?: string
  role: string
  content: string
  created_at?: string
  metadata?: string | Record<string, unknown>
}

type ConversationDetail = {
  messages?: ConversationMessage[]
  conversation?: {
    messages?: ConversationMessage[]
  }
}

async function apiRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  const result = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      result.message ||
        result.error ||
        `Request failed (${response.status})`,
    )
  }

  return result as T
}

function getPayload<T>(response: unknown): T {
  const result = response as { data?: T }
  return (result?.data ?? response) as T
}

function formatDate(date?: string) {
  if (!date) return ''

  const parsed = new Date(date)

  if (Number.isNaN(parsed.getTime())) return ''

  return parsed.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })
}

function formatAnswer(content: string) {
  return content.split('\n').map((line, index) => {
    const trimmed = line.trim()

    if (!trimmed) {
      return <div className="answer-space" key={index} />
    }

    if (/^#{1,3}\s/.test(trimmed)) {
      return (
        <h3 className="answer-heading" key={index}>
          {trimmed.replace(/^#{1,3}\s/, '')}
        </h3>
      )
    }

    if (/^[-*]\s/.test(trimmed)) {
      return (
        <div className="answer-list-item" key={index}>
          <span>•</span>
          <span>{trimmed.replace(/^[-*]\s/, '')}</span>
        </div>
      )
    }

    if (/^\d+[.)]\s/.test(trimmed)) {
      return (
        <div className="answer-list-item" key={index}>
          <span>{trimmed.match(/^\d+[.)]/)?.[0]}</span>
          <span>{trimmed.replace(/^\d+[.)]\s/, '')}</span>
        </div>
      )
    }

    return <p key={index}>{line}</p>
  })
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth',
    })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading])

  const loadConversations = useCallback(async () => {
    try {
      const response = await apiRequest<unknown>('/conversations')
      const payload = getPayload<unknown>(response)

      const list = Array.isArray(payload)
        ? payload
        : (
            payload as {
              conversations?: Conversation[]
            }
          )?.conversations ?? []

      setConversations(list as Conversation[])
    } catch (err) {
      console.error('Unable to load conversations:', err)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  const startNewChat = () => {
    setActiveConversationId(null)
    setMessages([])
    setInput('')
    setError('')
    setSidebarOpen(false)
    inputRef.current?.focus()
  }

  const openConversation = async (id: string) => {
    if (loading) return

    setActiveConversationId(id)
    setMessages([])
    setError('')
    setSidebarOpen(false)

    try {
      const response = await apiRequest<unknown>(
        `/conversations/${encodeURIComponent(id)}`,
      )

      const payload = getPayload<ConversationDetail>(response)

      const conversationMessages =
        payload.messages ??
        payload.conversation?.messages ??
        []

      const formattedMessages: Message[] = conversationMessages
        .filter(
          (message) =>
            message.role === 'user' ||
            message.role === 'assistant',
        )
        .map((message, index) => {
          let metadata: Record<string, unknown> = {}

          if (typeof message.metadata === 'string') {
            try {
              metadata = JSON.parse(message.metadata)
            } catch {
              metadata = {}
            }
          } else if (message.metadata) {
            metadata = message.metadata
          }

          return {
            id: message.id ?? `${id}-${index}`,
            role: message.role as 'user' | 'assistant',
            content: message.content,
            created_at: message.created_at,
            sources: Array.isArray(metadata.sources)
              ? (metadata.sources as Source[])
              : [],
            model:
              typeof metadata.model === 'string'
                ? metadata.model
                : undefined,
          }
        })

      setMessages(formattedMessages)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to load conversation.',
      )
    }
  }

  const sendMessage = async () => {
    const message = input.trim()

    if (!message || loading) return

    setError('')
    setInput('')
    setLoading(true)

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
    }

    setMessages((previous) => [...previous, userMessage])

    try {
      const response = await apiRequest<AgentResponse>(
        '/agent/chat',
        {
          method: 'POST',
          body: JSON.stringify({
            message,
            ...(activeConversationId
              ? { conversationId: activeConversationId }
              : {}),
          }),
        },
      )

      const data = response.data ?? response

      if (!data.answer) {
        throw new Error(
          response.message ||
            response.error ||
            'The agent returned an empty response.',
        )
      }

      if (data.conversationId) {
        setActiveConversationId(data.conversationId)
      }

      const assistantMessage: Message = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.answer,
        sources: data.sources ?? [],
        model: data.model,
      }

      setMessages((previous) => [
        ...previous,
        assistantMessage,
      ])

      await loadConversations()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong.',
      )

      setMessages((previous) =>
        previous.filter((item) => item.id !== userMessage.id),
      )

      setInput(message)
    } finally {
      setLoading(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="mobile-overlay"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}
      >
        <div className="sidebar-top">
          <button
            className="brand"
            onClick={startNewChat}
            aria-label="Minimi home"
          >
            <span className="brand-mark">m</span>
            <span>minimi</span>
          </button>

          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            ×
          </button>
        </div>

        <button
          className="new-chat-button"
          onClick={startNewChat}
        >
          <span>＋</span>
          New chat
          <kbd>⌘ K</kbd>
        </button>

        <div className="history-section">
          <div className="section-label">YOUR CHATS</div>

          {historyLoading ? (
            <div className="history-message">
              Loading conversations...
            </div>
          ) : conversations.length === 0 ? (
            <div className="history-message">
              Your conversations will appear here.
            </div>
          ) : (
            <div className="conversation-list">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`conversation-item ${
                    activeConversationId === conversation.id
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => void openConversation(conversation.id)}
                  title={conversation.title || 'Conversation'}
                >
                  <span className="conversation-icon">◷</span>

                  <span className="conversation-title">
                    {conversation.title || 'New conversation'}
                  </span>

                  <span className="conversation-date">
                    {formatDate(
                      conversation.updated_at ||
                        conversation.created_at,
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="status-dot" />

          <div>
            <div className="status-title">Agent online</div>
            <div className="status-subtitle">
              Web search enabled
            </div>
          </div>

          <span className="version-label">BETA</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button menu-button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
            >
              ☰
            </button>

            <span className="topbar-title">Workspace</span>
            <span className="topbar-divider">/</span>
            <span className="topbar-current">AI Assistant</span>
          </div>

          <div className="topbar-right">
            <span className="connection-indicator">
              <span />
              Connected
            </span>

            <div className="avatar">M</div>
          </div>
        </header>

        <section className="chat-area">
          {messages.length === 0 ? (
            <div className="welcome-screen">
              <div className="welcome-icon">
                <span>✳</span>
              </div>

              <div className="eyebrow">
                YOUR WEB RESEARCH ASSISTANT
              </div>

              <h1>
                What can I help you <span>discover?</span>
              </h1>

              <p className="welcome-description">
                Ask anything. Minimi searches the web, checks
                sources, and brings the useful information together.
              </p>

              <div className="suggestion-grid">
                <button
                  className="suggestion-card"
                  onClick={() =>
                    setInput(
                      'What are the latest developments in artificial intelligence?',
                    )
                  }
                >
                  <span className="suggestion-icon purple">✳</span>

                  <span>
                    <strong>Latest AI developments</strong>
                    <small>
                      Explore recent news and announcements
                    </small>
                  </span>

                  <span className="suggestion-arrow">↗</span>
                </button>

                <button
                  className="suggestion-card"
                  onClick={() =>
                    setInput(
                      'Compare the latest React and Vue features.',
                    )
                  }
                >
                  <span className="suggestion-icon blue">⌘</span>

                  <span>
                    <strong>Compare technologies</strong>
                    <small>
                      Research tools and understand differences
                    </small>
                  </span>

                  <span className="suggestion-arrow">↗</span>
                </button>

                <button
                  className="suggestion-card"
                  onClick={() =>
                    setInput(
                      'Find recent announcements from major technology companies.',
                    )
                  }
                >
                  <span className="suggestion-icon orange">◷</span>

                  <span>
                    <strong>Track announcements</strong>
                    <small>
                      Find what changed recently
                    </small>
                  </span>

                  <span className="suggestion-arrow">↗</span>
                </button>

                <button
                  className="suggestion-card"
                  onClick={() =>
                    setInput(
                      'Research the latest trends in IoT and edge computing.',
                    )
                  }
                >
                  <span className="suggestion-icon green">⌁</span>

                  <span>
                    <strong>Research a topic</strong>
                    <small>
                      Get useful information from the web
                    </small>
                  </span>

                  <span className="suggestion-arrow">↗</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="messages-container">
              {messages.map((message) => (
                <article
                  className={`message-row ${message.role}`}
                  key={message.id}
                >
                  <div className={`message-avatar ${message.role}`}>
                    {message.role === 'user' ? 'Y' : 'm'}
                  </div>

                  <div className="message-content">
                    <div className="message-author">
                      {message.role === 'user' ? 'You' : 'Minimi'}

                      {message.model &&
                        message.role === 'assistant' && (
                          <span className="model-label">
                            {message.model}
                          </span>
                        )}
                    </div>

                    <div className="message-text">
                      {message.role === 'assistant' ? (
                        formatAnswer(message.content)
                      ) : (
                        <p>{message.content}</p>
                      )}
                    </div>

                    {message.sources &&
                      message.sources.length > 0 && (
                        <div className="sources-panel">
                          <div className="sources-heading">
                            <span>↗</span>
                            Sources

                            <span className="source-count">
                              {message.sources.length}
                            </span>
                          </div>

                          <div className="sources-list">
                            {message.sources.map(
                              (source, index) => (
                                <a
                                  className="source-card"
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  key={`${source.url}-${index}`}
                                >
                                  <span className="source-number">
                                    {index + 1}
                                  </span>

                                  <span className="source-details">
                                    <strong>
                                      {source.title ||
                                        source.site_name ||
                                        source.url}
                                    </strong>

                                    <small>
                                      {source.site_name ||
                                        source.url}
                                    </small>

                                    {source.snippet && (
                                      <span>{source.snippet}</span>
                                    )}
                                  </span>

                                  <span className="source-external">
                                    ↗
                                  </span>
                                </a>
                              ),
                            )}
                          </div>
                        </div>
                      )}
                  </div>
                </article>
              ))}

              {loading && (
                <div className="message-row assistant">
                  <div className="message-avatar assistant">
                    m
                  </div>

                  <div className="message-content">
                    <div className="message-author">Minimi</div>

                    <div className="thinking-indicator">
                      <span />
                      <span />
                      <span />
                      <small>Searching and thinking...</small>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </section>

        <footer className="composer-area">
          {error && (
            <div className="error-message">
              <span>⚠</span>
              {error}

              <button
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          <div className="composer">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Minimi anything..."
              rows={1}
              disabled={loading}
            />

            <div className="composer-bottom">
              <div className="composer-hint">
                <span className="search-hint-icon">⌕</span>
                Web search enabled
                <span className="hint-divider">·</span>
                <span>Enter to send</span>
              </div>

              <button
                className="send-button"
                onClick={() => void sendMessage()}
                disabled={!input.trim() || loading}
                aria-label="Send message"
              >
                {loading ? '…' : '↑'}
              </button>
            </div>
          </div>

          <p className="disclaimer">
            Minimi can make mistakes. Check important information
            against its sources.
          </p>
        </footer>
      </main>
    </div>
  )
}

export default App
