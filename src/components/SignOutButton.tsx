"use client";

import { signOut } from "next-auth/react";

export function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="inline-flex min-h-11 items-center rounded-lg border border-white/15 px-4 text-sm text-white/70 transition-colors hover:border-white/30 hover:bg-white/5 hover:text-white"
    >
      Sign out
    </button>
  );
}
