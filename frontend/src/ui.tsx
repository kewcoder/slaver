import { Fragment, useEffect, useState, type ReactNode } from "react";
import { fetchAvatar, type SlaveBot } from "./api";
import { useLang, type Lang } from "./i18n";

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

export type IconName = "home" | "chat" | "market" | "code" | "settings" | "users" | "plus" | "search" | "arrow" | "grid" | "chevron" | "spark" | "logout" | "globe" | "check" | "folder" | "menu" | "external" | "bot" | "upload" | "rocket" | "copy" | "git" | "tag" | "x";

export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7" /></>,
    chat: <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" />,
    market: <><path d="M4 9h16l-1 12H5Z" /><path d="M8 9V7a4 4 0 0 1 8 0v2M9 13v2M15 13v2" /></>,
    code: <><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1 1.55V21h-4v-.08a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3v-4h.08a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3h4v.08a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.25.6.84 1 1.5 1H21v4h-.08a1.7 1.7 0 0 0-1.52 1Z" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    chevron: <path d="m8 10 4 4 4-4" />,
    spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
    rocket: <><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" /><path d="M9 15 6 12c1-4 4.5-8 11-9-1 6.5-5 10-9 11Z" /><circle cx="14.5" cy="9.5" r="1.5" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
    git: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 8v8M18 11c0 4-6 3-10 6" /></>,
    tag: <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9Z" /><circle cx="8" cy="8" r="1.5" /></>,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    bot: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></>,
  };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#62d89d] text-[#0b2117] shadow-[0_8px_24px_rgba(50,180,120,0.16)]">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 7.5h8.5a3.5 3.5 0 0 1 0 7H9.5a3.5 3.5 0 0 0 0 7H18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M6 3v4M4 5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="text-[19px] font-extrabold tracking-[-0.045em] text-[#f1f5f1]">slaver<span className="text-[#62d89d]">.</span></span>}
    </span>
  );
}

export function SectionHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="panel-title mb-1.5">{eyebrow}</div>}
        <h2 className="page-heading text-[26px] font-bold text-[#f1f5f1]">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#8f9d96]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Small inline spinner for busy buttons. */
export function Spinner() {
  const { t } = useLang();
  return (
    <svg className="inline h-4 w-4 animate-spin text-current" viewBox="0 0 24 24" fill="none" aria-label={t("common.loading")}>
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
  const { t } = useLang();
  return (
    <span className="typing-dots" aria-label={t("chat.typing")}>
      <span />
      <span />
      <span />
    </span>
  );
}
export function dayLabel(iso: string | undefined, lang: Lang): string {
  const d = iso ? new Date(iso) : new Date();
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return lang === "id" ? "Hari ini" : "Today";
  if (sameDay(d, yesterday)) return lang === "id" ? "Kemarin" : "Yesterday";
  return d.toLocaleDateString(lang === "id" ? "id-ID" : undefined, { weekday: "long", month: "long", day: "numeric" });
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
