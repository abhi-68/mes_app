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
    <div className="flex min-h-screen items-center justify-center bg-gray-100 px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-900 text-base font-semibold text-white">
            T
          </span>
          <span className="text-lg font-bold tracking-tight text-gray-950">
            Thermal Corp<span className="ml-1.5 font-normal text-gray-500">MES</span>
          </span>
        </div>

        {/* Filament's login: one card, labelled fields, a full-width primary button. */}
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="mb-6 text-2xl font-bold tracking-tight text-gray-950">Sign in</h1>

          <form onSubmit={submit} className="space-y-6">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-medium leading-6 text-gray-950"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="block min-h-12 w-full rounded-lg border-0 bg-white px-3 text-base text-gray-950 ring-1 ring-inset ring-gray-300 transition duration-75 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary-600"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1 block text-sm font-medium leading-6 text-gray-950"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block min-h-12 w-full rounded-lg border-0 bg-white px-3 text-base text-gray-950 ring-1 ring-inset ring-gray-300 transition duration-75 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary-600"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700 ring-1 ring-inset ring-danger-600/10"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="min-h-12 w-full rounded-lg bg-gray-900 px-3 text-base font-medium text-white transition duration-75 hover:bg-gray-800 disabled:bg-gray-200 disabled:text-gray-400"
            >
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
