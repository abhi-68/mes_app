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

/*
  The state scale a fitter already knows, applied consistently everywhere:

    red    stopped   BLOCKED, ON_HOLD
    amber  waiting   PENDING, RELEASED \u2014 could be running and is not
    green  running   IN_PROGRESS, and only that
    blue   moving    IN_TRANSIT
    grey   inactive  PLANNED, DONE, SHIPPED, CANCELLED

  Done is deliberately GREY rather than green. On a floor board green has to mean
  "producing right now"; a finished job is not producing, and two greens meaning
  different things is how a glance stops being trustworthy.
*/
const STATUS_STYLE: Record<string, { bg: string; fg: string; dot: string; label: string }> = {
  PLANNED: { bg: "bg-gray-100", fg: "text-gray-600", dot: "bg-gray-400", label: "Planned" },
  PENDING: {
    bg: "bg-warning-50",
    fg: "text-warning-700",
    dot: "bg-warning-500",
    label: "Not started",
  },
  RELEASED: {
    bg: "bg-warning-50",
    fg: "text-warning-700",
    dot: "bg-warning-500",
    label: "Ready to start",
  },
  IN_PROGRESS: {
    bg: "bg-success-50",
    fg: "text-success-700",
    dot: "bg-success-600",
    label: "Running",
  },
  DONE: { bg: "bg-gray-100", fg: "text-gray-600", dot: "bg-gray-400", label: "Done" },
  IN_TRANSIT: {
    bg: "bg-info-50",
    fg: "text-info-700",
    dot: "bg-info-500",
    label: "In transit",
  },
  SHIPPED: { bg: "bg-gray-100", fg: "text-gray-600", dot: "bg-gray-400", label: "Shipped" },
  BLOCKED: { bg: "bg-danger-50", fg: "text-danger-700", dot: "bg-danger-600", label: "Stopped" },
  ON_HOLD: { bg: "bg-danger-50", fg: "text-danger-700", dot: "bg-danger-600", label: "On hold" },
  CANCELLED: { bg: "bg-gray-100", fg: "text-gray-600", dot: "bg-gray-400", label: "Cancelled" },
};

export function statusLabel(status: string): string {
  return STATUS_STYLE[status]?.label ?? status;
}

/**
 * Filament's badge: a squared-off tag, not a pill.
 *
 * The dot is kept. Filament badges take an icon slot, so it is within the idiom,
 * and it is the only thing stopping status from being carried by hue alone —
 * which a colour-blind operator cannot read.
 */
export function StatusPill({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.PENDING;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg font-medium ring-1 ring-inset ring-current/20 ${s.bg} ${s.fg} ${
        size === "sm" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs"
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
      ? "bg-success-600"
      : tone === "blocked"
        ? "bg-danger-600"
        : tone === "navy"
          ? "bg-primary-600"
          : pct === 0
            ? "bg-gray-400"
            : "bg-warning-500";

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-gray-200/80 ${className}`}
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
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
  /** Adds a hover lift. Only for a surface that is itself a link or a button. */
  interactive?: boolean;
} & Record<`data-${string}`, string | undefined>) {
  /* One card treatment: white, a hairline border, and no shadow to speak of.
     Definition comes from the border so stacked surfaces stay quiet. */
  return (
    <As
      {...rest}
      className={`rounded-lg border border-gray-200 bg-white ${
        interactive ? "transition duration-75 hover:border-gray-300 hover:bg-gray-50" : ""
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
  /* Small and tight. A shop screen is read at a glance from a metre away, and the
     thing that has to be big is the STATE, not the word "Floor map". */
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1">{eyebrow}</p>}
        <h1 className="text-lg font-semibold tracking-tight text-gray-900">{title}</h1>
        {subtitle && (
          <div className="mt-1 max-w-2xl text-[13px] leading-relaxed text-gray-500">{subtitle}</div>
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
    <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="text-[13px] font-semibold leading-5 text-gray-900">{children}</h2>
      {note && <span className="text-[13px] text-gray-500">{note}</span>}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-base font-semibold text-gray-950">{title}</p>
      {hint && (
        <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-gray-500">{hint}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

/* The primary action is near-black, not a colour. Colour on a button competes
   with colour that means a machine has stopped, and the machine has to win. */
const BUTTON_TONE: Record<ButtonTone, string> = {
  primary:
    "bg-gray-900 text-white hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400",
  secondary:
    "bg-white text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:text-gray-400",
  danger: "bg-danger-600 text-white hover:bg-danger-700 disabled:bg-gray-200 disabled:text-gray-400",
  ghost: "text-gray-600 hover:bg-gray-100",
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
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background-color,border-color,color,transform] duration-100 ease-out active:scale-[0.985] disabled:cursor-not-allowed disabled:active:scale-100 ${BUTTON_TONE[tone]} ${sizing} ${className}`}
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
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background-color,border-color,color,transform] duration-100 ease-out active:scale-[0.985] ${BUTTON_TONE[tone]} ${sizing}`}
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
    tone === "alert" ? "text-danger-600" : tone === "muted" ? "text-gray-400" : "text-gray-950";
  return (
    <Panel className="relative overflow-hidden px-4 py-3.5">
      {tone === "alert" && (
        <span className="absolute inset-y-0 left-0 w-0.5 bg-danger-600" aria-hidden />
      )}
      <p className="text-[13px] text-gray-500">{label}</p>
      <p className={`tnum mt-0.5 text-2xl font-semibold tracking-tight ${valueTone}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-gray-400">{note}</p>}
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
    neutral: "bg-gray-50 text-gray-600 ring-gray-500/10",
    alert: "bg-danger-50 text-danger-700 ring-danger-600/10",
    quiet: "bg-gray-50 text-gray-500 ring-gray-500/10",
  } as const;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-lg px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tones[tone]}`}
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
        className="min-h-11 min-w-56 flex-1 rounded-lg border-0 bg-white px-3 text-sm text-gray-950 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary-600"
      />
      <button
        type="submit"
        className="inline-flex min-h-9 items-center rounded-md bg-gray-900 px-3 text-sm font-medium text-white transition-colors hover:bg-gray-800"
      >
        {label}
      </button>
      {value ? (
        <a
          href={action}
          className="inline-flex min-h-11 items-center rounded-lg bg-white px-4 text-sm font-medium text-gray-700 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
        >
          Clear
        </a>
      ) : null}
    </form>
  );
}

/** Shared table chrome, so every table on the site has the same rhythm. */
export const TH =
  "px-4 py-3 text-left text-sm font-semibold text-gray-950 bg-gray-50";
export const TD = "px-4 py-4 align-top text-sm text-gray-700";
export const TR = "border-t border-gray-200 transition duration-75 hover:bg-gray-50";

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
