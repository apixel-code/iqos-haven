"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { authError, authRequest, consumeLinkToken } from "../lib/auth";

type Mode = "login" | "forgot" | "reset" | "invite";
export function AuthForm({ mode }: { mode: Mode }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [complete, setComplete] = useState(false);
  const [linkReady, setLinkReady] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const token = useRef<string | null>(null);
  const initialized = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const isLink = mode === "reset" || mode === "invite";
  useEffect(() => {
    if (isLink) {
      const capture = () => {
        token.current = consumeLinkToken(window.location, window.history);
        setLinkReady(Boolean(token.current));
        setMessage("");
        formRef.current?.reset();
      };
      // Consume initial URL once under StrictMode, then consume any new same-page email link.
      if (!initialized.current) {
        initialized.current = true;
        capture();
      }
      window.addEventListener("hashchange", capture);
      return () => window.removeEventListener("hashchange", capture);
    }
    if (initialized.current) return;
    initialized.current = true;
    if (mode === "login") {
      const reason = new URLSearchParams(window.location.search).get("reason");
      const notices: Record<string, string> = {
        expired: "Your session ended. Sign in again to continue.",
        out: "You signed out.",
        reset: "Password updated. Sign in with your new password.",
        invited: "Account ready. Sign in with your new password.",
      };
      const notice = reason ? notices[reason] : undefined;
      if (notice) queueMicrotask(() => setMessage(notice));
    }
  }, [isLink, mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    if (
      isLink &&
      password.normalize("NFKC") !== String(data.get("confirm") ?? "").normalize("NFKC")
    ) {
      setMessage("Passwords do not match.");
      return;
    }
    if (isLink && [...password.normalize("NFKC")].length < 12) {
      setMessage("Use at least 12 characters for your new password.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (mode === "login") {
        await authRequest("login", { email: String(data.get("email")), password });
        window.location.replace("/");
      } else if (mode === "forgot") {
        await authRequest("forgot", { email: String(data.get("email")) });
        formRef.current?.reset();
        setComplete(true);
      } else {
        if (!token.current) {
          setMessage("This link is missing or invalid.");
          return;
        }
        await authRequest(mode === "reset" ? "reset" : "invite/accept", {
          token: token.current,
          password,
        });
        token.current = null;
        formRef.current?.reset();
        window.location.replace(`/login?reason=${mode === "reset" ? "reset" : "invited"}`);
      }
    } catch (error) {
      setMessage(authError(error, mode));
      const fields = formRef.current?.querySelectorAll<HTMLInputElement>(
        'input[name="password"], input[name="confirm"]',
      );
      fields?.forEach((field) => {
        field.value = "";
      });
    } finally {
      setBusy(false);
    }
  }
  const title = {
    login: "Sign in",
    forgot: "Reset your password",
    reset: "Set a new password",
    invite: "Accept your invitation",
  }[mode];
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <span className="brand-mark" aria-hidden="true">
          IH
        </span>
        <span>
          Iqos <strong>Haven</strong>
        </span>
        <span className="badge">Admin</span>
      </div>
      <section className="auth-card">
        <h1>{complete ? "Check your email" : title}</h1>
        <p className="muted">
          {complete
            ? "If the address belongs to an active admin account, a reset link is on its way. The link works for 30 minutes."
            : mode === "login"
              ? "Iqos Haven admin · staff and owner access"
              : mode === "forgot"
                ? "Enter the email you sign in with. We’ll send a link to set a new password."
                : mode === "invite"
                  ? "Set your password to activate your invited account. Your name and role are assigned by the owner."
                  : "Choose a new password for your account."}
        </p>
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {isLink && !linkReady && (
          <p className="notice" role="status">
            Open the complete link from your email. If it has expired or was used, request a new
            link.
          </p>
        )}
        {!complete && (
          <form ref={formRef} onSubmit={submit} aria-busy={busy}>
            {!isLink && (
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={320}
                  disabled={busy}
                />
              </label>
            )}
            {mode !== "forgot" && (
              <>
                <label>
                  {isLink ? "New password" : "Password"}
                  <span className="password-field">
                    <input
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete={isLink ? "new-password" : "current-password"}
                      required
                      maxLength={isLink ? 128 : 1024}
                      disabled={busy}
                    />
                    <button
                      className="text-button"
                      type="button"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </span>
                </label>
                {isLink && (
                  <>
                    <p className="small muted">
                      Use 12–128 characters. Avoid your name, email, the store name and common
                      passwords.
                    </p>
                    <label>
                      Confirm new password
                      <input
                        name="confirm"
                        type="password"
                        autoComplete="new-password"
                        required
                        maxLength={128}
                        disabled={busy}
                      />
                    </label>
                  </>
                )}
              </>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={busy || (isLink && !linkReady)}
            >
              {busy
                ? "Please wait…"
                : mode === "forgot"
                  ? "Send reset link"
                  : mode === "reset"
                    ? "Update password"
                    : mode === "invite"
                      ? "Create account"
                      : "Sign in"}
            </button>
          </form>
        )}
        {mode === "login" ? (
          <Link href="/forgot" className="auth-link">
            Forgot password?
          </Link>
        ) : (
          <Link href="/login" className="auth-link">
            Back to sign in
          </Link>
        )}
      </section>
      <p className="auth-foot">Secure workspace · Iqos Haven</p>
    </main>
  );
}
