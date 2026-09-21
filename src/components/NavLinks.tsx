"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation with a current-section state.
 *
 * Client-side because it needs the pathname. Worth the boundary: without it every
 * screen looks the same at a glance, and on a floor tablet people were the only
 * thing telling you where you were.
 */
export function NavLinks({
  links,
}: {
  links: { href: string; label: string; badge?: number }[];
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="flex flex-wrap items-center gap-0.5">
      {links.map((l) => {
        const active = isActive(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            /* min-h-11 is 44px: the W3C enhanced target size. These are tapped by
               gloved hands on a tablet, and a 32px-high link is a miss waiting to
               happen — the visual weight is unchanged, only the hit area grows. */
            className={`relative inline-flex min-h-11 items-center rounded-md px-3 text-sm transition-colors ${
              active ? "text-white" : "text-white/60 hover:bg-white/5 hover:text-white/90"
            }`}
          >
            {l.label}
            {l.badge !== undefined && l.badge > 0 && (
              <span
                className="tnum ml-1.5 inline-flex min-w-[1.15rem] items-center justify-center rounded-full bg-blocked-solid px-1 py-px text-[11px] font-semibold text-white"
                aria-label={`${l.badge} needing attention`}
              >
                {l.badge > 99 ? "99+" : l.badge}
              </span>
            )}
            {active && (
              <span
                className="brand-rule absolute inset-x-3 bottom-0.5 h-0.5 rounded-full"
                aria-hidden
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
