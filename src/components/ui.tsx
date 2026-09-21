import Link from "next/link";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Status vocabulary — one source of truth so every screen agrees      */
/* ------------------------------------------------------------------ */

export type TaskStatus = "PENDING" | "IN_PROGRESS" | "DONE" | "BLOCKED";
export type OrderStatus =
  | "PLANNED"
  | "RELEASED"
  | "IN_PROGRESS"
  | "DONE"
  | "ON_HOLD"
  | "CANCELLED";

const STATUS_STYLE: Record<string, { bg: string; fg: string; dot: string; label: string }> = {
  PENDING: { bg: "bg-idle-bg", fg: "text-idle-fg", dot: "bg-idle-solid", label: "Not started" },
  PLANNED: { bg: "bg-idle-bg", fg: "text-idle-fg", dot: "bg-idle-solid", label: "Planned" },
  RELEASED: { bg: "bg-idle-bg", fg: "text-idle-fg", dot: "bg-idle-solid", label: "Ready to start" },
  IN_PROGRESS: {
    bg: "bg-active-bg",
    fg: "text-active-fg",
    dot: "bg-active-solid",
    label: "In progress",
  },
  DONE: { bg: "bg-ok-bg", fg: "text-ok-fg", dot: "bg-ok-solid", label: "Done" },
  BLOCKED: { bg: "bg-blocked-bg", fg: "text-blocked-fg", dot: "bg-blocked-solid", label: "Blocked" },
  ON_HOLD: { bg: "bg-blocked-bg", fg: "text-blocked-fg", dot: "bg-blocked-solid", label: "On hold" },
  CANCELLED: { bg: "bg-idle-bg", fg: "text-idle-fg", dot: "bg-idle-solid", label: "Cancelled" },
};

export function statusLabel(status: string): string {
  return STATUS_STYLE[status]?.label ?? status;
}

export function StatusPill({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.PENDING;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium ring-1 ring-inset ring-current/10 ${s.bg} ${s.fg} ${
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export function ProgressBar({
  value,
  tone = "auto",
  className = "",
}: {
  /** 0..1 */
  value: number;
  tone?: "auto" | "ok" | "active" | "blocked" | "navy";
  className?: string;
}) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const fill =
    tone === "ok" || (tone === "auto" && pct === 100)
      ? "bg-ok-solid"
      : tone === "blocked"
        ? "bg-blocked-solid"
        : tone === "navy"
          ? "bg-navy-800"
          : pct === 0
            ? "bg-idle-solid"
            : "bg-active-solid";

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-steel-200/80 ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Panel({
  children,
  className = "",
  as: As = "div",
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
  /** Adds a hover lift. Only for a surface that is itself a link or a button. */
  interactive?: boolean;
}) {
  return (
    <As
      className={`rounded-xl border border-steel-200/80 bg-white shadow-card ${
        interactive
          ? "transition-all duration-150 hover:-translate-y-px hover:border-steel-300 hover:shadow-raised"
          : ""
      } ${className}`}
    >
      {children}
    </As>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  eyebrow,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** A short label above the title, for orientation on a deep page. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-steel-200 pb-6">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h1 className="text-[1.75rem] font-semibold leading-tight text-navy-900">{title}</h1>
        {subtitle && (
          <div className="mt-2 max-w-2xl text-[0.9375rem] leading-relaxed text-steel-500">
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionHeading({
  children,
  note,
}: {
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-[0.9375rem] font-semibold text-navy-900">{children}</h2>
      {note && <span className="text-xs text-steel-400">{note}</span>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-steel-300 bg-white/60 px-6 py-12 text-center">
      <p className="text-[0.9375rem] font-medium text-steel-600">{title}</p>
      {hint && (
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-steel-400">{hint}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_TONE: Record<ButtonTone, string> = {
  primary:
    "bg-navy-800 text-white shadow-card hover:bg-navy-900 active:translate-y-px disabled:bg-steel-300 disabled:shadow-none",
  secondary:
    "border border-steel-300 bg-white text-steel-700 shadow-card hover:border-steel-400 hover:bg-steel-50 active:translate-y-px disabled:text-steel-400 disabled:shadow-none",
  danger:
    "bg-blocked-solid text-white shadow-card hover:brightness-95 active:translate-y-px disabled:bg-steel-300 disabled:shadow-none",
  ghost: "text-steel-600 hover:bg-steel-100 active:translate-y-px",
};

export function Button({
  children,
  tone = "primary",
  size = "md",
  type = "button",
  disabled,
  onClick,
  className = "",
}: {
  children: ReactNode;
  tone?: ButtonTone;
  /** "lg" is sized for gloved hands on a shop-floor tablet. */
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  /*
    Heights, not paddings, decide whether a gloved hand hits this on a tablet.
    "lg" is 48px for the primary floor actions (Start, Mark done); "md" is 44px,
    the W3C enhanced target size, and is the default everywhere; "sm" is 36px and
    is reserved for dense desk tables — never for anything used on the floor.
  */
  const sizing =
    size === "lg"
      ? "px-6 text-base min-h-12"
      : size === "sm"
        ? "px-3 text-xs min-h-9"
        : "px-4 text-sm min-h-11";
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-100 disabled:cursor-not-allowed ${BUTTON_TONE[tone]} ${sizing} ${className}`}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  children,
  href,
  tone = "secondary",
  size = "md",
}: {
  children: ReactNode;
  href: string;
  tone?: ButtonTone;
  size?: "sm" | "md" | "lg";
}) {
  /*
    Heights, not paddings, decide whether a gloved hand hits this on a tablet.
    "lg" is 48px for the primary floor actions (Start, Mark done); "md" is 44px,
    the W3C enhanced target size, and is the default everywhere; "sm" is 36px and
    is reserved for dense desk tables — never for anything used on the floor.
  */
  const sizing =
    size === "lg"
      ? "px-6 text-base min-h-12"
      : size === "sm"
        ? "px-3 text-xs min-h-9"
        : "px-4 text-sm min-h-11";
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-100 ${BUTTON_TONE[tone]} ${sizing}`}
    >
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Figures                                                             */
/* ------------------------------------------------------------------ */

/**
 * One headline number with its label. Defined once because four screens were
 * each drawing their own and they had drifted apart by a few pixels.
 */
export function Stat({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "default" | "alert" | "muted";
}) {
  const valueTone =
    tone === "alert" ? "text-blocked-fg" : tone === "muted" ? "text-steel-400" : "text-navy-900";
  return (
    <Panel className="relative overflow-hidden px-5 py-4">
      {tone === "alert" && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-blocked-solid" aria-hidden />
      )}
      <p className="eyebrow">{label}</p>
      <p className={`tnum mt-1.5 text-[1.75rem] font-semibold leading-none ${valueTone}`}>
        {value}
      </p>
      {note && <p className="mt-1.5 text-xs text-steel-400">{note}</p>}
    </Panel>
  );
}

/** A small labelled tag. `tone` carries meaning; the label always repeats it. */
export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "alert" | "quiet";
}) {
  const tones = {
    neutral: "bg-steel-100 text-steel-600",
    alert: "bg-blocked-bg text-blocked-fg",
    quiet: "bg-steel-100 text-steel-500",
  } as const;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * A search box that is a plain GET form.
 *
 * No client component and no debounce: the result is a real URL, so a filtered
 * list can be bookmarked, reloaded and sent to someone else — which is what
 * happens when a supervisor is asked "which order was it?" over the radio.
 */
export function SearchBox({
  action,
  value,
  placeholder,
  keep = {},
  label = "Search",
}: {
  action: string;
  value?: string;
  placeholder?: string;
  /** Other query parameters to carry through, so searching keeps the filter. */
  keep?: Record<string, string | undefined>;
  label?: string;
}) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-center gap-2" role="search">
      {Object.entries(keep).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null
      )}
      <input
        type="search"
        name="q"
        defaultValue={value ?? ""}
        placeholder={placeholder}
        aria-label={label}
        className="min-h-11 min-w-56 flex-1 rounded-md border border-steel-300 bg-white px-3 text-sm"
      />
      <button
        type="submit"
        className="inline-flex min-h-11 items-center rounded-md bg-navy-800 px-4 text-sm font-medium text-white transition-colors hover:bg-navy-900"
      >
        {label}
      </button>
      {value ? (
        <a
          href={action}
          className="inline-flex min-h-11 items-center rounded-md border border-steel-300 bg-white px-4 text-sm text-steel-600 hover:bg-steel-50"
        >
          Clear
        </a>
      ) : null}
    </form>
  );
}

/** Shared table chrome, so every table on the site has the same rhythm. */
export const TH =
  "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-steel-400";
export const TD = "px-4 py-3 align-top text-sm";
export const TR = "border-b border-steel-100 last:border-0 transition-colors hover:bg-steel-50/70";

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return formatMinutes(Math.round(seconds / 60));
}

export function formatRelativeDue(due: Date | null): string {
  if (!due) return "No due date";
  const days = Math.round((due.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

export function formatWhen(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
