import { auth } from "@/auth";

export type Role = "WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN";

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
  stationId: number | null;
};

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return {
    id: Number(session.user.id),
    name: session.user.name ?? "",
    email: session.user.email ?? "",
    role: session.user.role,
    stationId: session.user.stationId ?? null,
  };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not signed in");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    throw new Error(`This action needs ${roles.join(" or ")} access`);
  }
  return user;
}

export const isManager = (role: Role) => role === "SUPERVISOR" || role === "ADMIN";
