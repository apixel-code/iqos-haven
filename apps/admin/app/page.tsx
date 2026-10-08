import { Button } from "@ih/ui-core";

/**
 * Placeholder (roadmap step 8). Real sign-in arrives in step 37 against AuthController (step 30).
 * No demo accounts, no default passwords.
 */
export default function AdminHome() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <section className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-2">
        <p className="font-mono text-xs uppercase tracking-wider text-ink-3">Iqos Haven</p>
        <h1 className="mt-1 text-xl font-semibold">Admin</h1>
        <p className="mt-2 text-sm text-ink-2">
          Foundation is running. Sign-in is not enabled yet.
        </p>
        <Button className="mt-6 w-full" disabled>
          Sign in
        </Button>
      </section>
    </main>
  );
}
