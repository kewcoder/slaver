import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchChatDetail,
  fetchChats,
  fetchMe,
  fetchModels,
  fetchUsage,
  finishChat,
  formatUsd,
  login,
  register,
  setToken,
  streamChat,
  type ChatSummary,
  type UsageSummary,
  type User,
} from "./api";

function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res =
        mode === "register"
          ? await register(email, password, name)
          : await login(email, password);
      onAuth(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>Slaver</h1>
        <p className="muted">Sign up or log in to start chatting.</p>
        <div className="tabs">
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Sign up
          </button>
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Log in
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy} className="primary">
            {busy ? "Please wait..." : mode === "register" ? "Create account" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}

interface UiMessage {
  key: number;
  role: string;
  content: string;
}

function LogsView({ summary }: { summary: UsageSummary | null }) {
  if (!summary) return <div className="center muted">Loading usage...</div>;
  return (
    <div className="logs">
      <div className="credit-cards">
        <div className="credit-card">
          <div className="credit-label">Remaining credit</div>
          <div className="credit-value">{formatUsd(summary.credit_usd)}</div>
        </div>
        <div className="credit-card">
          <div className="credit-label">Spent (demo)</div>
          <div className="credit-value">{formatUsd(summary.spent_usd)}</div>
        </div>
      </div>
      <p className="muted small">
        Every account starts with $10 demo credit. Costs are estimated from provider token usage.
      </p>
      {summary.logs.length === 0 ? (
        <p className="muted">No usage yet — send a chat message first.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Chat</th>
                <th>Model</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.logs.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{new Date(l.created_at).toLocaleString()}</td>
                  <td>{l.chat_title ?? "—"}{l.estimated ? " (est.)" : ""}</td>
                  <td className="nowrap">{l.model}</td>
                  <td className="num">{l.prompt_tokens.toLocaleString()}</td>
                  <td className="num">{l.completion_tokens.toLocaleString()}</td>
                  <td className="num">{formatUsd(l.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState("muse-spark-1.3");
  const [view, setView] = useState<"chat" | "logs">("chat");
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const keyRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await fetchMe());
    } catch {
      setToken(null);
      setUser(null);
    }
  }, []);

  const refreshChats = useCallback(async () => {
    try {
      setChats(await fetchChats());
    } catch {
      /* keep old list on transient failure */
    }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setChecking(false));
    fetchModels()
      .then((m) => {
        setModels(m);
        const d = m.find((x) => x.default);
        if (d) setModel(d.id);
      })
      .catch(() => {});
    refreshChats();
  }, [refreshUser, refreshChats]);

  useEffect(() => {
    if (view === "logs" && user) {
      fetchUsage().then(setUsage).catch(() => {});
    }
  }, [view, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  async function openChat(id: string | null) {
    setError("");
    setChatId(id);
    setView("chat");
    if (!id) {
      setMessages([]);
      return;
    }
    try {
      const detail = await fetchChatDetail(id);
      setMessages(
        detail.messages.map((m) => ({ key: ++keyRef.current, role: m.role, content: m.content })),
      );
      setModel(detail.chat.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open chat.");
    }
  }

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setError("");
    setInput("");
    const userKey = ++keyRef.current;
    const assistantKey = ++keyRef.current;
    setMessages((prev) => [
      ...prev,
      { key: userKey, role: "user", content: text },
      { key: assistantKey, role: "assistant", content: "" },
    ]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamUsage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null = null;

    const patchAssistant = (content: string) =>
      setMessages((prev) =>
        prev.map((m) => (m.key === assistantKey ? { ...m, content } : m)),
      );

    let content = "";
    try {
      // Stream for the live typing effect, then finalize below.
      const returnedId = await streamChat(chatId, text, model, {
        signal: controller.signal,
        onToken: (delta) => {
          content += delta;
          patchAssistant(content);
        },
        onUsage: (u) => {
          streamUsage = u;
        },
      });
      const finalId = returnedId || chatId;
      if (!finalId) throw new Error("Server did not return a chat id.");
      await finishChat(finalId, content, streamUsage);
      setChatId(finalId);
      await refreshChats();
      await refreshUser();
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        patchAssistant(`${content}\n— stopped.`);
        setError("Stream stopped. The partial reply was not saved.");
      } else {
        setError(err instanceof Error ? err.message : "Chat failed.");
        setMessages((prev) => prev.filter((m) => m.key !== assistantKey));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function logout() {
    setToken(null);
    setUser(null);
    setMessages([]);
    setChats([]);
    setChatId(null);
    setUsage(null);
  }

  if (checking) return <div className="center muted">Loading...</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="side-head">
          <div className="brand">Slaver</div>
          <button type="button" className="ghost" onClick={() => openChat(null)}>
            + New
          </button>
        </div>
        <nav className="chat-list">
          {chats.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chat-item${c.id === chatId ? " active" : ""}`}
              onClick={() => openChat(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
          {chats.length === 0 && <p className="muted small side-note">No chats yet.</p>}
        </nav>
        <div className="side-foot">
          <button
            type="button"
            className={view === "logs" ? "ghost active" : "ghost"}
            onClick={() => {
              setView("logs");
              fetchUsage().then(setUsage).catch(() => {});
            }}
          >
            Usage &amp; logs
          </button>
          <div className="credit-line" title="Demo credit remaining">
            {formatUsd(user.credit_usd)} left
          </div>
          <div className="muted small">{user.email}</div>
          <button type="button" onClick={logout} className="ghost">
            Log out
          </button>
        </div>
      </aside>

      <div className="app">
        <header className="topbar">
          <div className="view-tabs">
            <button
              type="button"
              className={view === "chat" ? "active" : ""}
              onClick={() => setView("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              className={view === "logs" ? "active" : ""}
              onClick={() => setView("logs")}
            >
              Logs
            </button>
          </div>
          <div className="topbar-right">
            <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
              {models.length === 0 && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </header>

        {view === "logs" ? (
          <main className="thread">
            <LogsView summary={usage} />
          </main>
        ) : (
          <>
            <main className="thread">
              {messages.length === 0 && (
                <div className="empty">
                  <h2>Hi, {user.name || user.email}.</h2>
                  <p className="muted">
                    Type a message below to start chatting. History is saved — pick it up from the
                    sidebar anytime.
                  </p>
                </div>
              )}
              {messages.map((m) => (
                <div key={m.key} className={`bubble-row ${m.role}`}>
                  <div className="bubble">
                    <div className="who">{m.role === "user" ? "You" : "Assistant"}</div>
                    <div className="text">{m.content || (streaming ? "…" : "")}</div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </main>

            {error && <p className="error bar">{error}</p>}

            <form className="composer" onSubmit={send}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Type a message... (Enter to send, Shift+Enter for a new line)"
                rows={2}
              />
              {streaming ? (
                <button type="button" onClick={stop} className="danger">
                  Stop
                </button>
              ) : (
                <button type="submit" disabled={!input.trim()} className="primary">
                  Send
                </button>
              )}
            </form>
          </>
        )}
      </div>
    </div>
  );
}
