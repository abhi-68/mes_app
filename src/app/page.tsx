import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { SupervisorHomeScreen } from "@/components/home/SupervisorHome";
import { AdminHomeScreen } from "@/components/home/AdminHome";
import { supervisorHome, adminHome } from "@/lib/home";
import { alertsFor } from "@/lib/alerts";

/**
 * The home screen, which is a different screen for each role.
 *
 * Everyone used to land on the same plant overview. It read well and answered
 * nobody's first question: a fitter does not open the app to see a progress bar
 * for the whole floor, they open it to find out what to pick up. That overview
 * still exists — it is the Orders page, and it is open to every role, because
 * "where is my unit" is a question anyone may be asked.
 */
export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const alerts = await alertsFor(user);

  if (user.role === "ADMIN") {
    return <AdminHomeScreen data={await adminHome()} user={user} alertCount={alerts.length} />;
  }

  if (user.role === "SUPERVISOR") {
    return (
      <SupervisorHomeScreen
        data={await supervisorHome()}
        user={user}
        alertCount={alerts.length}
      />
    );
  }

  // A worker's first screen is the stations. There is nothing useful to put in
  // front of "which machine are you on", and a summary page they have to click
  // past every morning is a page that only costs them time.
  redirect("/my-station");
}
