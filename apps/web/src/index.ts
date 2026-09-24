/**
 * @redai/web — Next.js UI (chat-first Workbench).
 *
 * DECISION (D02): to keep the M0 build fast and offline-reproducible, the web
 * app is a compiling placeholder in M0. The real Next.js application (routes,
 * SSE client, Workbench shell) is scaffolded in T10, which is the UI milestone.
 * See docs/implementation-decisions.md.
 */

export const WEB_PACKAGE = '@redai/web';

export const WEB_STATUS = 'placeholder: Next.js app scaffolded in T10' as const;
