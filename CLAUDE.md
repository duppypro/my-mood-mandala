# my-mood-mandala

Web app: draw ephemeral, symmetric sand-brush art that matches your mood. Public. Started as a
Google AI Studio export.

## Stack

Vite + TypeScript + Tailwind v4 + D3, with Firebase Auth (Google sign-in) and Firestore (one
stroke document per user). The whole app is `src/main.ts`; `index.html` is its shell.

## Exceptions to the global Web Project Standards

- **npm packages plus a Vite build, not CDN with no build step.** Inherited from the AI Studio
  export; `does-it-glider` is the no-build app, this one is not.
- **TypeScript**, typechecked with `bun run lint`.

## Commands

| Purpose | Command |
|---|---|
| Install | `bun install` |
| Dev server | `bun run dev` — Vite on `0.0.0.0:3000` |
| Build | `bun run build` → `dist/` |
| Typecheck | `bun run lint` |

## Hard gates

- **`bun run dev` binds every interface.** On the VPS, reach it through `serve` (behind Cloudflare
  Access), never on the raw public port.
- **`firestore.rules` is security code.** Every change needs a stated reason, and a test where one
  is possible.
- **The Firebase web config is public by design; the Gemini key is not.** `GEMINI_API_KEY`
  (`.env.example`) stays server-side. Never import `@google/genai` from `src/`, because everything
  under `src/` ships to the browser.
