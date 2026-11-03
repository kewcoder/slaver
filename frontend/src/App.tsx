import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMe,
  fetchModels,
  login,
  register,
  setToken,
  streamChat,
  type ChatMessage,
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

interface UiMessage extends ChatMessage {
  key: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [model, setModel] = useState("muse-spark-1.3");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
    fetchModels()
      .then((m) => {
        setModels(m);
        const d = m.find((x) => x.default);
        if (d) setModel(d.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;
    setError("");
    setInput("");
    const userMsg: UiMessage = { key: ++keyRef.current, role: "user", content: text };
    const history: ChatMessage[] = [...messages, userMsg].map(({ role, content }) => ({
      role,
      content,
    }));
    const assistantKey = ++keyRef.current;
    setMessages([...messages, userMsg, { key: assistantKey, role: "assistant", content: "" }]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(history, model, (delta) => {
        setMessages((prev) =>
          prev.map((m) => (m.key === assistantKey ? { ...m, content: m.content + delta } : m)),
        );
      }, controller.signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.key === assistantKey ? { ...m, content: m.content + "\n— stopped." } : m,
          ),
        );
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
  }

  if (checking) return <div className="center muted">Loading...</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Slaver</div>
        <div className="topbar-right">
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
            {models.length === 0 && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="muted small">{user.email}</span>
          <button type="button" onClick={logout} className="ghost">
            Log out
          </button>
        </div>
      </header>

      <main className="thread">
        {messages.length === 0 && (
          <div className="empty">
            <h2>Hi, {user.name || user.email}.</h2>
            <p className="muted">Type a message below to start chatting. Responses stream in token by token.</p>
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
    </div>
  );
}
