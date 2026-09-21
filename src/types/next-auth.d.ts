import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN";
      stationId: number | null;
    } & DefaultSession["user"];
  }

  interface User {
    role: "WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN";
    stationId: number | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: "WORKER" | "FORKLIFT" | "SUPERVISOR" | "ADMIN";
    stationId: number | null;
  }
}
