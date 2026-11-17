# JobSwitch AI v2 — Frontend Architecture

> Doc 5 of the spec set. Covers `apps/dashboard` (Next.js, existing) extensions, the new React Native/Expo app, shared Redux state design, and styling boundaries.

> **What you'll learn here:** this doc is where "folder structure" stops being a religious debate and becomes a set of tradeoffs you can defend — colocated-by-feature vs layered-by-type, App Router server/client boundary rules, and exactly where Redux earns its keep vs where it's overhead. This is also the doc most directly reusable when someone asks in an interview "walk me through how you'd structure a Next.js app."

---

## 1. Next.js App Router — folder structure (extends existing `apps/dashboard`)

Your existing structure is route-per-folder under `src/app/`. Extend it feature-colocated, not type-layered — i.e. don't create a global `components/`, `hooks/`, `actions/` dumping ground; keep each feature's pieces next to its route, the same pattern your existing `pipeline/`, `matches/`, `applications/[id]/` folders already follow.

```
apps/dashboard/src/
├── app/
│   ├── layout.tsx                  # root layout — add Redux Provider + SSE connection here
│   ├── page.tsx                    # NEW: dashboard home (currently missing — flagged in the audit)
│   ├── (existing routes: login, pipeline, matches, profile, applications/[id])
│   │
│   ├── companies/                  # NEW — F3
│   │   ├── page.tsx                # Server Component: list + upload form
│   │   ├── actions.ts              # Server Actions: uploadCompanyList, deleteCompany
│   │   └── CompanyUploadForm.tsx   # Client Component: file input + progress
│   │
│   ├── apply-queue/                # NEW — F6/F7/F8, the dry-run review screen
│   │   ├── page.tsx                # Server Component: initial fetch
│   │   ├── actions.ts              # approveAction, rejectAction, approveBulk
│   │   ├── ApplyActionCard.tsx     # Client: shows skill match, draft preview, approve/reject buttons
│   │   └── ApplyQueueList.tsx      # Client: subscribes to Redux slice for live updates
│   │
│   └── amatya/                     # NEW — F10
│       ├── page.tsx                # or a slide-over panel triggered from the notif bell, see §4
│       ├── ChatThread.tsx          # Client: message list + streaming response
│       └── ChatInput.tsx
│
├── components/                     # ONLY truly cross-feature primitives (Button, Badge, Modal)
│   └── notifications/
│       └── NotificationBell.tsx    # NEW — reads Redux unappliedCount, opens Amatya panel
│
├── lib/
│   ├── apiServer.ts                 # existing — server-side fetch wrapper, unchanged
│   ├── sse.ts                       # NEW — client-side EventSource wrapper, dispatches to Redux
│   └── config.ts                    # existing
│
└── store/                           # NEW — Redux Toolkit
    ├── index.ts                     # store setup, configureStore
    ├── apiSlice.ts                  # RTK Query base API (baseQuery = your existing REST/GraphQL endpoint)
    ├── applyActionsSlice.ts         # unappliedCount + normalized action list
    └── amatyaSlice.ts               # thread list, current thread's messages (streaming buffer)
```

**Why feature-colocated, argued properly:** when `apply-queue/` breaks, everything relevant is in one folder — the Server Component, its Server Actions, and its Client Components. A type-layered structure (`components/`, `actions/`, `hooks/` each holding files from every feature) forces you to jump across 4 folders to understand one feature, and it's the structure that scales worst as a team grows (merge conflicts concentrate in the same few "everything" folders). This is also, not coincidentally, the direction Next.js's own App Router conventions push you — `page.tsx`/`actions.ts` living next to each other is idiomatic, not a stylistic choice you're inventing.

### 1.1 Server vs Client Component boundary — the rule, stated once

- **Default to Server Component.** Only add `'use client'` when a file needs: state (`useState`), effects, browser APIs, or event handlers.
- Server Components fetch data directly (via `apiServer.ts`, as your existing pages already do) — no `useEffect` fetch-on-mount pattern anywhere in this app, that pattern is a Pages-Router-era workaround the App Router exists to remove.
- Server Actions (`actions.ts`, `'use server'`) handle all mutations — forms `action={approveAction}` directly, no client-side `fetch` + manual loading state for basic mutations. Reach for `useTransition`/`useActionState` (as your existing `NewApplicationForm.tsx` already does) only when you need pending/error UI beyond what a plain form submission gives you.

> **What you'll learn here:** this Server/Client boundary is the single most-interview-relevant Next.js concept right now (App Router adoption means this gets asked constantly) — and the "why" matters more than the rule: Server Components ship zero JS to the client for that component, so defaulting to server-first is a real performance decision, not a style preference.

---

## 2. React Native (Expo) — project layout

New package: `apps/mobile/` (pnpm workspace member, alongside `apps/dashboard`).

```
apps/mobile/
├── app/                        # Expo Router — same file-based routing mental model as Next's App Router
│   ├── _layout.tsx             # root layout, Redux Provider (same store package — see §3)
│   ├── (tabs)/
│   │   ├── index.tsx           # dashboard home
│   │   ├── apply-queue.tsx
│   │   └── profile.tsx
│   └── amatya.tsx              # modal/stack screen
├── components/
├── lib/
│   ├── apiClient.ts             # thin GraphQL client (urql or Apollo — see §2.1) — NOT apiServer.ts,
│   │                             # RN has no server runtime, this calls the Go GraphQL BFF directly
│   └── sse.ts                   # RN-compatible EventSource (react-native-sse or a WebSocket fallback —
│                                  # native EventSource support is inconsistent across RN environments,
│                                  # confirm this before committing to SSE on mobile specifically)
├── app.json                     # Expo config — includes `"web": { "bundler": "metro" }` for PWA target
└── package.json
```

### 2.1 Why GraphQL specifically pays off here (not just "because we built it")

The Next.js dashboard already has `apiServer.ts` doing server-to-server REST calls — it never needed GraphQL to avoid over-fetching because the Server Component controls exactly what it fetches. **React Native has no equivalent server hop** — every query is a direct client-to-API round trip over a phone's variable-quality network. This is precisely the condition GraphQL was built for (Facebook's own original motivating case). So: Next.js dashboard keeps using REST via `apiServer.ts` for its Server Components; RN/PWA uses the GraphQL BFF from `03-API-contracts.md`. Same backend, different client, different fetch strategy — because the network conditions are genuinely different, not because "GraphQL is newer."

### 2.2 PWA via `react-native-web`

Expo's web target (`app.json`'s `web` config) compiles the same RN codebase via `react-native-web` + Metro's web bundler. This is what lets one codebase ship to Play Store (native RN) and browser (PWA) — add a `manifest.json` + service worker (Expo has a config plugin for this: `expo-service-worker` or a manual `public/sw.js`, same pattern your existing `apps/dashboard/public/sw.js` already demonstrates) on top of the web build output.

---

## 3. Shared Redux design — one store shape, two hosts

Put the Redux slices in a **shared workspace package** (`packages/store/`), imported by both `apps/dashboard` and `apps/mobile` — not duplicated. The slice logic (reducers, RTK Query endpoints) is 100% platform-agnostic; only the `Provider` wiring and the SSE transport differ per platform.

```ts
// packages/store/src/applyActionsSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ApplyActionsState {
  unappliedCount: number;
  actions: Record<string, ApplyAction>;   // normalized by id — avoids array-search on every update
}

const initialState: ApplyActionsState = { unappliedCount: 0, actions: {} };

const applyActionsSlice = createSlice({
  name: 'applyActions',
  initialState,
  reducers: {
    // Called by the SSE listener (see lib/sse.ts on each platform), NOT by
    // a manual count — see 03-API-contracts.md's note on why the server's
    // count is authoritative.
    applyActionEventReceived(state, action: PayloadAction<ApplyActionEvent>) {
      state.unappliedCount = action.payload.unappliedCount;
      // upsert the individual action if the event carries one
    },
  },
  extraReducers: (builder) => {
    // RTK Query's initial fetch populates the same normalized shape
    builder.addMatcher(apiSlice.endpoints.getApplyActions.matchFulfilled, (state, { payload }) => {
      state.unappliedCount = payload.unappliedCount;
      payload.actions.forEach(a => { state.actions[a.id] = a; });
    });
  },
});
```

**Why normalized-by-id, not an array:** an SSE event updates *one* action's status. Finding it in an array is O(n) and easy to get subtly wrong (stale closures over array indices). A `Record<id, ApplyAction>` update is O(1) and matches exactly how RTK's own `createEntityAdapter` is designed to be used — worth using `createEntityAdapter` directly here instead of hand-rolling the `Record`, actually; mentioned in prose so you go look it up and use the real API rather than reinventing its behavior.

> **What you'll learn here:** normalized state shape is *the* Redux interview topic that separates "used Redux once" from "understands why Redux is shaped the way it is" — it's the same normalization discipline as third-normal-form in SQL, applied to client state, and for the identical reason (avoid update anomalies from duplicated/denormalized copies of the same entity).

---

## 4. Notification bell → Amatya panel wiring

- `NotificationBell.tsx` (Client Component) reads `state.applyActions.unappliedCount` via `useSelector` — pure render, no fetch.
- Click opens Amatya as a slide-over panel (dashboard) or a modal screen (RN) — same `ChatThread` component, different container, because the chat UI itself is platform-shareable (put `ChatThread`'s core logic in `packages/store` or a shared `packages/ui-core` if you want true logic sharing; the actual JSX still needs a RN version and a web version since `<div>` isn't valid in RN — this is the normal, accepted limit of RN/web code sharing, don't fight it by over-abstracting).
- On open, dispatch an RTK Query call for thread history, then subscribe to `amatya.token` SSE events, appending to a local streaming buffer in `amatyaSlice` until `done: true`.

---

## 5. Styling — Tailwind (web) + NativeWind (RN)

- `apps/dashboard`: migrate off hand-written `globals.css` to Tailwind (new — per your ask). Do this as its own small PR, not mixed into feature work, so a broken layout is easy to attribute.
- `apps/mobile`: NativeWind lets the same Tailwind class syntax work in RN (`className="flex-1 p-4"` compiles to RN `StyleSheet` objects under the hood). Share a `tailwind.config.ts` (colors, spacing scale) across both packages via `packages/tailwind-config/` — this is what gives you one design-token source of truth instead of two drifting copies.

---

## What's next

Per-feature spec docs (F1–F11), each with: user story, exact acceptance criteria, the theory/example callouts for that feature's specific tech, and a checklist of what "done" means (including tests) — these are the docs you'll actually build against feature-by-feature, and the last stop before writing implementation code.

Say **next** and I'll start with **F1 (Auth + RBAC)** and **F3 (Company Ingestion)** since those unblock everything else.
