import Link from "next/link";
import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { reasonCodes } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import { Panel, PageHeader, SectionHeading } from "@/components/ui";
import { NewReasonCodeForm, ToggleReasonButton } from "@/components/admin-forms";

const CATEGORY_LABEL: Record<string, string> = {
  BLOCKED: "Blocked",
  SCRAP: "Scrap",
  REWORK: "Rework",
  DOWNTIME: "Downtime",
};

export default async function ReasonCodesPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "ADMIN") redirect("/");

  const codes = await db
    .select()
    .from(reasonCodes)
    .orderBy(asc(reasonCodes.category), asc(reasonCodes.code));

  const grouped = Object.entries(CATEGORY_LABEL).map(([key, label]) => ({
    key,
    label,
    rows: codes.filter((c) => c.category === key),
  }));

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-9">
      <PageHeader
        title="Reason codes"
        subtitle="The fixed list people pick from on the floor."
        actions={
          <Link
            href="/admin"
            className="inline-flex min-h-11 items-center text-sm text-gray-500 hover:text-gray-950"
          >
            Back to setup
          </Link>
        }
      />

      <div className="mt-8 space-y-8">
        {grouped.map((g) => (
          <section key={g.key}>
            <SectionHeading note={`${g.rows.length} options`}>{g.label}</SectionHeading>
            <Panel className="divide-y divide-gray-100">
              {g.rows.length === 0 && (
                <p className="px-5 py-4 text-sm text-gray-400">Nothing set up yet.</p>
              )}
              {g.rows.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div>
                    <p className={`text-sm ${c.active ? "text-gray-900" : "text-gray-400 line-through"}`}>
                      {c.label}
                    </p>
                    <p className="text-xs text-gray-400 tnum">{c.code}</p>
                  </div>
                  <ToggleReasonButton id={c.id} active={c.active} />
                </div>
              ))}
            </Panel>
          </section>
        ))}
      </div>

      <Panel className="mt-8 p-5">
        <p className="mb-3 text-sm font-medium text-gray-700">Add a reason</p>
        <NewReasonCodeForm />
      </Panel>
    </div>
  );
}
