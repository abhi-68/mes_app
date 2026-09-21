import { requireUser } from "@/lib/session";
import { loadableUnits } from "@/lib/loading";
import { LoadingList } from "@/components/LoadingList";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/** Finished goods waiting to go on a truck. */
export default async function LoadingPage() {
  await requireUser();
  const units = await loadableUnits();

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-9">
      <PageHeader title="Ready to load" />
      <div className="mt-6">
        <LoadingList units={units} />
      </div>
    </div>
  );
}
