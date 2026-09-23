import { auth } from "@/auth";
import { AppShell, type NavGroup } from "./AppShell";
import { alertCountFor } from "@/lib/alerts";
import { getCurrentUser } from "@/lib/session";

const ROLE_LABEL: Record<string, string> = {
  WORKER: "Worker",
  FORKLIFT: "Forklift",
  SUPERVISOR: "Supervisor",
  ADMIN: "Admin",
};

/**
 * Builds the navigation and hands it to the shell.
 *
 * Grouped the way EzBizy's panels are: "My Work" is what this person does next,
 * everything else is reference. A role only ever sees the groups it can act on.
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) return <>{children}</>;

  const role = session.user.role;

  // The count is the alert system's whole delivery mechanism: nothing is pushed,
  // so this number is what makes someone open the page.
  const me = await getCurrentUser();
  const alertCount = me ? await alertCountFor(me) : 0;

  const groups: NavGroup[] = [];

  if (role === "FORKLIFT") {
    // A forklift driver has one job and therefore one screen.
    groups.push({
      label: "My Work",
      items: [{ href: "/loading", label: "Ready to load", icon: "dispatch" }],
    });
  } else {
    groups.push({
      label: "My Work",
      items: [
        // A worker's home IS the station list, so one link to it and not two.
        role === "WORKER"
          ? { href: "/my-station", label: "Stations", icon: "stations" as const }
          : { href: "/", label: "Home", icon: "home" as const },
        { href: "/alerts", label: "Alerts", icon: "alerts", badge: alertCount },
      ],
    });

    const manufacturing: NavGroup["items"] = [
      { href: "/floor", label: "Floor map", icon: "floor" },
      { href: "/orders", label: "Work orders", icon: "orders" },
      // Materials and finished units are two different questions asked by two
      // different people, so two lists rather than one mixed one.
      { href: "/inventory", label: "Inventory", icon: "stock" },
      { href: "/stock", label: "Stock", icon: "dispatch" },
    ];
    if (role === "SUPERVISOR" || role === "ADMIN") {
      manufacturing.push({ href: "/quality", label: "Quality", icon: "quality" });
      manufacturing.push({ href: "/waiting", label: "What's waiting", icon: "waiting" });
    }
    groups.push({ label: "Manufacturing", items: manufacturing });

    if (role === "SUPERVISOR" || role === "ADMIN") {
      groups.push({
        label: "Insights",
        items: [{ href: "/reports", label: "Reports", icon: "reports" }],
      });
    }
    if (role === "ADMIN") {
      groups.push({
        label: "Administration",
        items: [{ href: "/admin", label: "Setup", icon: "setup" }],
      });
    }
  }

  const name = session.user.name ?? "";
  const initials =
    name
      .split(" ")
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <AppShell groups={groups} user={{ name, role: ROLE_LABEL[role] ?? role, initials }}>
      {children}
    </AppShell>
  );
}
