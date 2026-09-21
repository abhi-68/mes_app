import Link from "next/link";
import { auth } from "@/auth";
import { SignOutButton } from "./SignOutButton";
import { NavLinks } from "./NavLinks";
import { alertCountFor } from "@/lib/alerts";
import { getCurrentUser } from "@/lib/session";

const ROLE_LABEL: Record<string, string> = {
  WORKER: "Worker",
  FORKLIFT: "Forklift",
  SUPERVISOR: "Supervisor",
  ADMIN: "Admin",
};

/**
 * A dark app bar, not a white one.
 *
 * Two reasons. It takes the brand navy from their printed identity and puts it
 * where it is seen on every screen, and it separates the application chrome from
 * the work — on a white-on-white layout the navigation and the content compete,
 * which on a shop tablet at arm's length is genuinely harder to scan.
 */
export async function TopNav() {
  const session = await auth();
  if (!session?.user) return null;

  const role = session.user.role;

  // The count is the alert system's whole delivery mechanism: nothing is pushed,
  // so this number is what makes someone open the page.
  const me = await getCurrentUser();
  const alertCount = me ? await alertCountFor(me) : 0;

  // A forklift driver has one job and therefore one screen.
  const links: { href: string; label: string; badge?: number }[] =
    role === "FORKLIFT"
      ? [{ href: "/loading", label: "Ready to load" }]
      : [
          // A worker's home IS the station list, so one link to it and not two.
          ...(role === "WORKER"
            ? [{ href: "/my-station", label: "Stations" }]
            : [{ href: "/", label: "Home" }]),
          { href: "/alerts", label: "Alerts", badge: alertCount },
          { href: "/floor", label: "Floor map" },
          { href: "/orders", label: "Work orders" },
          // One place for stock: what is on the racks AND what the jobs still
          // need. Two links to two views of the same shelves was the confusion.
          { href: "/inventory", label: "Stock" },
        ];

  if (role === "SUPERVISOR" || role === "ADMIN") {
    links.push({ href: "/delivery-notes", label: "Dispatch" });
    links.push({ href: "/quality", label: "Quality" });
    links.push({ href: "/waiting", label: "What's waiting" });
    links.push({ href: "/reports", label: "Reports" });
  }
  if (role === "ADMIN") {
    links.push({ href: "/admin", label: "Setup" });
  }

  const initials = session.user.name
    ?.split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 bg-navy-900 text-white shadow-raised">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-1.5">
        <div className="flex min-w-0 items-center gap-7">
          <Link href="/" className="flex min-h-11 shrink-0 items-center gap-2.5">
            <span className="brand-rule block h-5 w-1.5 rounded-sm" aria-hidden />
            <span className="text-[0.9375rem] font-semibold tracking-tight">
              Thermal Corp
              <span className="ml-1.5 font-normal text-white/50">MES</span>
            </span>
          </Link>
          <NavLinks links={links} />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2.5">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-white/80"
              aria-hidden
            >
              {initials}
            </span>
            <span className="hidden text-sm leading-tight text-white/80 sm:block">
              {session.user.name}
              <span className="block text-[11px] text-white/45">{ROLE_LABEL[role]}</span>
            </span>
          </div>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
