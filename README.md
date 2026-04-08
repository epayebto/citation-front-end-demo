# Monaco citation demo

A small vanilla TypeScript prototype showing:

- Monaco editor
- module Web Worker for live citation parsing
- Swiss-style regex detection inspired by your Python service
- inline highlighting
- hover preview bubble
- click-to-pin sidebar panel
- mock resolution layer returning multilingual article payloads

## Run

```bash
npm install
npm run dev
```

Then open the local Vite URL.

## Notes

- This prototype uses **full-text parsing in the worker** with a tiny debounce of 35 ms.
- The `changes` payload is already included, so you can later upgrade the worker to incremental reparsing.
- The resolver is mocked in `src/mockResolver.ts`; replace it with your real API.
- Hover preview currently shows one language in the Monaco tooltip, while the sidebar shows all returned languages.

## File overview

- `src/main.ts` — UI, Monaco integration, decorations, hover provider
- `src/citationWorker.ts` — parser worker
- `src/mockResolver.ts` — mock API/service layer
- `src/types.ts` — shared types
- `src/sampleText.ts` — demo content
