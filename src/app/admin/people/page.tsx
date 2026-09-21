import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users, stations } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { Panel, PageHeader, SectionHeading } from "@/components/ui";
import { NewUserForm, NewStationForm, ToggleUserButton } from "@/components/admin-forms";

const ROLE_LABEL: Record<string, string> = {
  WORKER: "Worker",
  FORKLIFT: "Forklift",
  SUPERVISOR: "Supervisor",
  ADMIN: "Admin",
};

export default async function PeoplePage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") redirect("/");

  const [people, stationRows] = await Promise.all([
    db.query.users.findMany({ with: { station: true }, orderBy: [asc(users.name)] }),
    db.select().from(stations).orderBy(asc(stations.id)),
  ]);

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="People & stations"
        subtitle="Workers see only their own station. Supervisors see every station and can correct recorded times. Admins can also change this setup."
        actions={
          <Link
            href="/admin"
            className="inline-flex min-h-11 items-center text-sm text-steel-500 hover:text-navy-900"
          >
            Back to setup
          </Link>
        }
      />

      <section className="mt-8">
        <SectionHeading note={`${people.length} people`}>People</SectionHeading>
        <Panel className="divide-y divide-steel-100">
          {people.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div>
                <p className={`text-sm font-medium ${p.active ? "text-steel-900" : "text-steel-400"}`}>
                  {p.name}
                  {!p.active && <span className="ml-2 text-xs text-steel-400">deactivated</span>}
                </p>
                <p className="text-xs text-steel-400">
                  {p.email} · {ROLE_LABEL[p.role]}
                  {p.station ? ` · ${p.station.name}` : ""}
                </p>
              </div>
              <ToggleUserButton id={p.id} active={p.active} />
            </div>
          ))}
        </Panel>

        <Panel className="mt-4 p-5">
          <p className="mb-3 text-sm font-medium text-steel-700">Add someone</p>
          <NewUserForm stations={stationRows.map((s) => ({ id: s.id, name: s.name }))} />
        </Panel>
      </section>

      <section className="mt-10">
        <SectionHeading note={`${stationRows.length} stations`}>Stations</SectionHeading>
        <Panel className="divide-y divide-steel-100">
          {stationRows.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div>
                <p className="text-sm text-steel-900">{s.name}</p>
                {s.description && <p className="text-xs text-steel-400">{s.description}</p>}
              </div>
            </div>
          ))}
        </Panel>

        <Panel className="mt-4 p-5">
          <p className="mb-3 text-sm font-medium text-steel-700">Add a station</p>
          <NewStationForm />
        </Panel>
      </section>
    </div>
  );
}
