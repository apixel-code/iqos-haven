import type { ReactNode } from "react";
import { SessionShell } from "../../components/session-shell";
export default function Layout({ children }: { children: ReactNode }) {
  return <SessionShell>{children}</SessionShell>;
}
