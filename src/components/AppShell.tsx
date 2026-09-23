"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bars3Icon,
  BellAlertIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  Cog6ToothIcon,
  CubeIcon,
  HomeIcon,
  MapIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
  TruckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { ArrowRightStartOnRectangleIcon } from "@heroicons/react/20/solid";

export type NavItem = {
  href: string;
  label: string;
  icon: IconKey;
  badge?: number;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

type IconKey =
  | "home"
  | "stations"
  | "alerts"
  | "floor"
  | "orders"
  | "stock"
  | "dispatch"
  | "quality"
  | "waiting"
  | "reports"
  | "setup";

/*
  Icons travel as a string key rather than a component. A server component builds
  the nav, and a component reference cannot cross that boundary.
*/
const ICONS: Record<IconKey, typeof HomeIcon> = {
  home: HomeIcon,
  stations: Squares2X2Icon,
  alerts: BellAlertIcon,
  floor: MapIcon,
  orders: ClipboardDocumentListIcon,
  stock: CubeIcon,
  dispatch: TruckIcon,
  quality: ShieldCheckIcon,
  waiting: ClockIcon,
  reports: ChartBarIcon,
  setup: Cog6ToothIcon,
};

/**
 * The application shell, in Filament's layout: a grouped sidebar on the left, a
 * thin topbar, and the page on a grey field.
 *
 * Replaces the wrapping top bar. The nav is a fixed-width column that scrolls
 * independently, so adding screens no longer pushes anything onto a second row.
 */
export function AppShell({
  groups,
  user,
  children,
}: {
  groups: NavGroup[];
  user: { name: string; role: string; initials: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // The admin section is indigo, the shop floor emerald — as in EzBizy's two panels.
  useEffect(() => {
    const panel = pathname.startsWith("/admin") ? "admin" : "shopfloor";
    document.documentElement.dataset.panel = panel;
  }, [pathname]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <nav className="flex flex-1 flex-col gap-y-7 overflow-y-auto px-4 py-6">
      {groups.map((group) => (
        <div key={group.label}>
          {group.label && (
            <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-gray-400">
              {group.label}
            </p>
          )}
          <ul className="flex flex-col gap-y-1">
            {group.items.map((item) => {
              const active = isActive(item.href);
              const Icon = ICONS[item.icon];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    /* A tap that navigates also closes the drawer it was tapped
                       in. A no-op on desktop, where nothing is open. */
                    onClick={() => setOpen(false)}
                    /* min-h-11 is 44px, the W3C enhanced target size. These are
                       tapped by gloved hands on a floor tablet. */
                    className={`group flex min-h-11 items-center gap-x-2.5 rounded-md px-2 text-sm transition-colors duration-75 ${
                      active
                        ? "bg-gray-200/70 font-medium text-gray-900"
                        : "text-gray-600 hover:bg-gray-200/40 hover:text-gray-900"
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] shrink-0 transition-colors duration-75 ${
                        active ? "text-gray-900" : "text-gray-400 group-hover:text-gray-600"
                      }`}
                      aria-hidden
                    />
                    <span className="truncate">{item.label}</span>
                    {item.badge !== undefined && item.badge > 0 && (
                      <span
                        className="tnum ml-auto inline-flex items-center rounded-lg bg-danger-50 px-2 py-0.5 text-xs font-medium text-danger-700 ring-1 ring-inset ring-danger-600/10"
                        aria-label={`${item.badge} needing attention`}
                      >
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <div className="flex h-14 shrink-0 items-center gap-x-2.5 px-4">
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-900 text-[11px] font-semibold text-white">
        T
      </span>
      <span className="text-sm font-semibold tracking-tight text-gray-900">
        Thermal Corp <span className="font-normal text-gray-400">MES</span>
      </span>
    </div>
  );

  return (
    <div className="min-h-full">
      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="fixed inset-0 bg-gray-950/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 left-0 flex w-64 flex-col border-r border-gray-200 bg-gray-100 shadow-lg">
            <div className="flex items-center justify-between pr-2">
              {brand}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-2 text-gray-500 hover:bg-gray-200"
              >
                <XMarkIcon className="h-6 w-6" aria-hidden />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-gray-200 bg-gray-100 lg:flex">
        {brand}
        {nav}
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-x-4 border-b border-gray-200 bg-white/90 px-4 backdrop-blur md:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            className="-ml-2 rounded-md p-2 text-gray-500 hover:bg-gray-100 lg:hidden"
          >
            <Bars3Icon className="h-5 w-5" aria-hidden />
          </button>

          <div className="ml-auto flex items-center gap-x-3">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-semibold text-gray-700"
              aria-hidden
            >
              {user.initials}
            </span>
            <span className="hidden text-sm leading-tight sm:block">
              <span className="block font-medium text-gray-900">{user.name}</span>
              <span className="block text-xs text-gray-500">{user.role}</span>
            </span>
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="inline-flex min-h-11 items-center gap-x-1.5 rounded-md px-2 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <ArrowRightStartOnRectangleIcon className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </header>

        <main>{children}</main>
      </div>
    </div>
  );
}
