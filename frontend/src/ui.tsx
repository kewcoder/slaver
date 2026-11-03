import { Fragment, useEffect, useState, type ReactNode } from "react";
import { fetchAvatar, type SlaveBot } from "./api";

const AVATAR_COLORS = [
  "bg-emerald-600",
  "bg-sky-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-orange-600",
  "bg-teal-600",
  "bg-indigo-600",
];

export function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}


export function BotAvatar({ bot, size = "md" }: { bot: SlaveBot; size?: "sm" | "md" | "lg" }) {
  const [url, setUrl] = useState<string | null>(null);
  const dims = size === "lg" ? "h-16 w-16 text-2xl" : size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-base";
  useEffect(() => {
    if (!bot.avatar_key) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchAvatar(bot.id).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [bot.id, bot.avatar_key]);
  if (url) {
    return (
      <img
        src={url}
        alt={bot.name}
        className={`${dims} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <div className={`${dims} ${avatarColor(bot.id)} flex shrink-0 items-center justify-center rounded-full font-bold text-white`}>
      {(bot.name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

/** Small inline spinner for busy buttons. */
export function Spinner() {
  return (
    <svg className="inline h-4 w-4 animate-spin text-current" viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/** ChatGPT-style composer glyphs. */
export function PlusIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MicIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

export function ArrowUpIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function WaveIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="10" width="2.4" height="4" rx="1.2" />
      <rect x="8.2" y="7" width="2.4" height="10" rx="1.2" />
      <rect x="12.4" y="4" width="2.4" height="16" rx="1.2" />
      <rect x="16.6" y="8" width="2.4" height="8" rx="1.2" />
    </svg>
  );
}

/** Three bouncing dots for "bot is typing". Motion is disabled when the OS asks for reduced motion. */
export function TypingDots() {
  return (
    <span className="typing-dots" aria-label="Bot is typing">
      <span />
      <span />
      <span />
    </span>
  );
}
export function dayLabel(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function dayKey(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function renderMentions(content: string): ReactNode[] {
  return content.split(/(@[\w.-]+)/g).map((part, i) =>
    part.startsWith("@") && part.length > 1 ? (
      <span key={i} className="rounded bg-emerald-900/60 px-0.5 font-semibold text-emerald-300">{part}</span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
