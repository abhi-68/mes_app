"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

/** Just a login. Nothing to read, nothing to decide. */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      setError("Wrong email or password.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-steel-50 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-3">
          <span className="brand-rule block h-7 w-1.5 rounded-sm" aria-hidden />
          <span className="text-lg font-semibold tracking-tight text-navy-900">
            Thermal Corp<span className="ml-1.5 font-normal text-steel-400">MES</span>
          </span>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            aria-label="Email"
            className="min-h-12 w-full rounded-lg border border-steel-300 bg-white px-3 text-base shadow-card placeholder:text-steel-400 focus:border-navy-600 focus:outline-none"
          />
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            className="min-h-12 w-full rounded-lg border border-steel-300 bg-white px-3 text-base shadow-card placeholder:text-steel-400 focus:border-navy-600 focus:outline-none"
          />

          {error && (
            <p role="alert" className="rounded-lg bg-blocked-bg px-3 py-2 text-sm text-blocked-fg">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="min-h-12 w-full rounded-lg bg-navy-800 px-3 text-base font-medium text-white shadow-card transition-all duration-100 hover:bg-navy-900 active:translate-y-px disabled:bg-steel-300"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
