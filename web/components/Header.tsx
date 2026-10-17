"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { StatusResponse } from "@/lib/types";

export type Tone = "ok" | "idle" | "warn" | "down";

export function summarize(status: StatusResponse | null, statusError: string | null): { tone: Tone; text: string } {
  if (statusError) return { tone: "down", text: "Console can't load its data" };
  if (!status) return { tone: "idle", text: "Connecting" };
  const { worker, zone } = status;
  switch (worker.state) {
    case "offline":
      return { tone: "down", text: "Camera worker offline" };
    case "error":
      return { tone: "down", text: "Camera worker needs attention" };
    case "loading_model":
      return { tone: "idle", text: "Loading models" };
    case "starting":
    case "connecting":
      return { tone: "idle", text: "Starting camera worker" };
    case "running":
      return zone ? { tone: "ok", text: `Watching ${zone.name}` } : { tone: "warn", text: "No zone drawn" };
  }
}

export function Header({ status, statusError }: { status: StatusResponse | null; statusError: string | null }) {
  const pathname = usePathname();
  const { tone, text } = summarize(status, statusError);
  return (
    <header className="topbar">
      <Link href="/" className="wordmark" aria-label="Linewatch, live console">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M2 18 L11 3 L20 18 Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M11 9 V13" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="11" cy="15.6" r="1.2" fill="currentColor" />
        </svg>
        <span>Linewatch</span>
      </Link>
      <span className="site">{status?.siteName ?? ""}</span>
      <nav className="nav" aria-label="Main">
        <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
          Live
        </Link>
        <Link href="/zones" aria-current={pathname === "/zones" ? "page" : undefined}>
          Zone
        </Link>
      </nav>
      <span className={`pill pill-${tone}`} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        {text}
      </span>
    </header>
  );
}
