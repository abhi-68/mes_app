import { requireUser, isManager } from "@/lib/session";
import { materialPlan } from "@/lib/material-planning";
import { MaterialPlanning } from "@/components/MaterialPlanning";

export const dynamic = "force-dynamic";

export default async function MaterialsPage() {
  const user = await requireUser();
  const plan = await materialPlan();
  return <MaterialPlanning rows={plan.rows} locationName={plan.location?.name ?? null}
    canReserve={isManager(user.role)} checkedAt={new Date().toISOString()} />;
}
