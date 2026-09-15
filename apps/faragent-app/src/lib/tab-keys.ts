/**
 * Stable identities for workspace tabs.
 *
 * A tab's `key` says *what* it shows rather than *which* tab it is, so opening
 * something that is already open focuses its tab instead of piling up a second
 * one. Every producer of a tab builds its key here — that is the only thing
 * keeping the sidebar's "is this session open?" highlight honest.
 */
import type { Action, AgentKind } from "@/lib/ipc";

export function sessionTabKey(
  host: string,
  agent: AgentKind,
  sessionId: string,
): string {
  return `session:${host}:${agent}:${sessionId}`;
}

export function loginTabKey(host: string): string {
  return `login:${host}`;
}

export function installTabKey(
  host: string,
  agent: AgentKind,
  action: Action,
): string {
  return `install:${host}:${agent}:${action}`;
}
