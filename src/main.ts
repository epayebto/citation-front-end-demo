import './styles.css';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { SAMPLE_TEXT, judgmentSample } from './sampleText';
import { resolveCitation } from './apiResolver';
import type { ParsedCitation, ResolvedCitation, WorkerRequest, WorkerResponse } from './types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('App root not found.');
}

app.innerHTML = `
  <div class="app-shell">
    <section class="panel editor-panel">
      <div class="header">
        <div>
          <h1>CodeMirror legal citation demo</h1>
          <div class="subtle">Vanilla TypeScript, CodeMirror, module worker, live highlighting, API-backed Swiss law previews</div>
        </div>
        <div class="header-actions">
          <div class="theme-switch" role="group" aria-label="Theme selector">
            <button class="theme-button" id="theme-dark" type="button">Dark</button>
            <button class="theme-button" id="theme-light" type="button">Light</button>
          </div>
          <div class="badge">Swiss-style citation parsing</div>
        </div>
      </div>
      <div class="toolbar">
        <div class="badge-row">
          <span class="badge" id="citations-count">0 citations</span>
          <span class="badge" id="worker-latency">worker: -- ms</span>
          <span class="badge" id="resolver-state">resolver: idle</span>
          <span class="badge" id="input-latency">input: -- ms</span>
          <span class="badge" id="decorate-latency">decorate: -- ms</span>
          <span class="badge" id="frame-jank">frame: -- ms</span>
        </div>
        <div class="status" id="status-text">Ready.</div>
      </div>
      <div id="editor"></div>
      <div id="citation-bubble" class="citation-bubble hidden" aria-hidden="true"></div>
    </section>

    <aside class="panel sidebar">
      <div class="sidebar-section">
        <h2>Quick samples</h2>
        <button class="sample-button" data-sample="default">Load mixed Swiss citations</button>
        <button class="sample-button" data-sample="judgment">Load short judgment paragraph</button>
      </div>
      <div class="sidebar-section">
        <h2>Interaction</h2>
        <div class="subtle">Click inside a citation to pin its details here.</div>
      </div>
      <div class="sidebar-section">
        <h2>Pinned citation</h2>
        <div id="citation-list" class="citation-list">
          <div class="empty-state">No citation selected yet.</div>
        </div>
      </div>
    </aside>
  </div>
`;

const editorContainer = document.querySelector<HTMLDivElement>('#editor')!;
const citationsCount = document.querySelector<HTMLSpanElement>('#citations-count')!;
const workerLatency = document.querySelector<HTMLSpanElement>('#worker-latency')!;
const resolverState = document.querySelector<HTMLSpanElement>('#resolver-state')!;
const inputLatency = document.querySelector<HTMLSpanElement>('#input-latency')!;
const decorateLatency = document.querySelector<HTMLSpanElement>('#decorate-latency')!;
const frameJank = document.querySelector<HTMLSpanElement>('#frame-jank')!;
const statusText = document.querySelector<HTMLDivElement>('#status-text')!;
const citationList = document.querySelector<HTMLDivElement>('#citation-list')!;
const citationBubble = document.querySelector<HTMLDivElement>('#citation-bubble')!;
const themeDarkButton = document.querySelector<HTMLButtonElement>('#theme-dark')!;
const themeLightButton = document.querySelector<HTMLButtonElement>('#theme-light')!;

const worker = new Worker(new URL('./citationWorker.ts', import.meta.url), { type: 'module' });
const PARSE_DEBOUNCE_MS = 90;

type CitationDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

const setCitationDecorations = StateEffect.define<CitationDecoration[]>();

const citationDecorations = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(setCitationDecorations)) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const decoration of effect.value) {
          builder.add(decoration.from, decoration.to, decoration.decoration);
        }
        return builder.finish();
      }
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

let version = 0;
let latestText = SAMPLE_TEXT;
let latestCitations: ParsedCitation[] = [];
let parseTimeoutId: number | undefined;
let lastInputAt = 0;
let pendingParseSentAt = 0;
let lastWorkerRoundTripMs = 0;
let lastWorkerQueueDelayMs = 0;
let lastDecorationMs = 0;
let longestUpdateListenerMs = 0;
let longestSelectionDispatchMs = 0;
let maxFrameGapMs = 0;
let diagnosticsLogCounter = 0;
let lastPinnedCitationId: string | undefined;
const resolutionCache = new Map<string, ResolvedCitation>();
const pendingResolutions = new Map<string, Promise<ResolvedCitation>>();

type ThemeName = 'dark' | 'light';

function applyTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('citation-demo-theme', theme);
  themeDarkButton?.classList.toggle('active', theme === 'dark');
  themeLightButton?.classList.toggle('active', theme === 'light');
}

function renderPayloadContent(payload: import('./types').ArticlePreviewPayload): string {
  // If the API returned a focus (sub-article match), show that with context
  if (payload.focus) {
    const parts: string[] = [];
    if (payload.focus.chapeau) {
      parts.push(`<div class="focus-chapeau">${escapeHtml(payload.focus.chapeau)}</div>`);
    }
    parts.push(`<div class="focus-text">${escapeHtml(payload.focus.text)}</div>`);
    return parts.join('');
  }

  // Fallback: show excerpt or full text
  return `<div>${escapeHtml(payload.excerpt || payload.fullText || 'No article text returned.')}</div>`;
}

function renderSidebar(citation: ParsedCitation, resolved?: ResolvedCitation) {
  if (!resolved) {
    citationList.innerHTML = `
      <div class="citation-card">
        <strong>${escapeHtml(citation.rawSpan)}</strong>
        <div class="meta">Resolution pending</div>
        <div class="subtle">The citation has been detected, but article content is still loading.</div>
      </div>
    `;
    return;
  }

  if (!resolved.resolved || !resolved.payloads) {
    citationList.innerHTML = `
      <div class="citation-card">
        <strong>${escapeHtml(citation.rawSpan)}</strong>
        <div class="meta">Unresolved</div>
        <div class="subtle">${escapeHtml(resolved.reason ?? 'No result found.')}</div>
      </div>
    `;
    return;
  }

  const languages = Object.values(resolved.payloads)
    .map((payload) => {
      const breadcrumb = payload.hierarchyLabel
        ? `<div class="hierarchy">${escapeHtml(payload.hierarchyLabel)}</div>`
        : '';
      const sourceLink = payload.sourceUrl
        ? `<a class="source-link" href="${escapeHtml(payload.sourceUrl)}" target="_blank" rel="noopener">Fedlex</a>`
        : '';

      return `
        <div class="citation-card">
          <strong>${escapeHtml(payload.language.toUpperCase())} · ${escapeHtml(payload.articleLabel)}</strong>
          ${breadcrumb}
          <div class="meta">${escapeHtml(payload.title)} · SR ${escapeHtml(resolved.srNumber ?? '')} ${sourceLink}</div>
          ${renderPayloadContent(payload)}
        </div>
      `;
    })
    .join('');

  citationList.innerHTML = languages;
}

function renderBubble(citation: ParsedCitation, resolved?: ResolvedCitation) {
  if (!resolved) {
    return `
      <strong>${escapeHtml(citation.rawSpan)}</strong>
      <div class="meta">Loading article preview</div>
      <div class="subtle">Fetching citation details…</div>
    `;
  }

  if (!resolved.resolved || !resolved.payloads) {
    return `
      <strong>${escapeHtml(citation.rawSpan)}</strong>
      <div class="meta">Unresolved</div>
      <div class="subtle">${escapeHtml(resolved.reason ?? 'No result found.')}</div>
    `;
  }

  const preferred = resolved.payloads.fr ?? resolved.payloads.de ?? Object.values(resolved.payloads)[0];
  // Show focused text if available, otherwise excerpt
  const previewText = preferred.focus?.text ?? preferred.excerpt ?? preferred.fullText ?? '';

  return `
    <strong>${escapeHtml(citation.rawSpan)}</strong>
    <div class="meta">${escapeHtml(preferred.title)} · ${escapeHtml(preferred.articleLabel)}</div>
    <div class="bubble-preview">${escapeHtml(previewText)}</div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function buildDecorations() {
  return latestCitations.map((citation) => {
    const resolved = resolutionCache.get(citation.id);
    const className = resolved
      ? resolved.resolved
        ? 'detected-citation-resolved'
        : 'detected-citation-unresolved'
      : 'detected-citation';

    return {
      from: citation.start,
      to: citation.end,
      decoration: Decoration.mark({
        class: className,
        attributes: {
          'data-citation-id': citation.id
        }
      })
    };
  });
}

function updateDecorations() {
  const startedAt = performance.now();
  editor.dispatch({
    effects: setCitationDecorations.of(buildDecorations())
  });
  lastDecorationMs = performance.now() - startedAt;
  decorateLatency.textContent = `decorate: ${lastDecorationMs.toFixed(1)} ms`;
}

function scheduleParse(changes: Array<{ from: number; to: number; insertedText: string }>) {
  window.clearTimeout(parseTimeoutId);
  lastInputAt = performance.now();
  hideCitationBubble();

  parseTimeoutId = window.setTimeout(() => {
    latestText = editor.state.doc.toString();
    version += 1;
    pendingParseSentAt = performance.now();
    lastWorkerQueueDelayMs = pendingParseSentAt - lastInputAt;

    const request: WorkerRequest = {
      version,
      fullText: latestText,
      changes,
      selectionStart: editor.state.selection.main.head
    };

    statusText.textContent = 'Parsing citations…';
    inputLatency.textContent = `input: ${lastWorkerQueueDelayMs.toFixed(1)} ms`;
    worker.postMessage(request);
  }, PARSE_DEBOUNCE_MS);
}

function resolveAndRefresh(citation: ParsedCitation) {
  if (resolutionCache.has(citation.id)) {
    return Promise.resolve(resolutionCache.get(citation.id)!);
  }

  const pending = pendingResolutions.get(citation.id);
  if (pending) {
    return pending;
  }

  resolverState.textContent = `resolver: loading ${citation.rawSpan}`;
  const promise = resolveCitation(citation).then((resolved) => {
    resolutionCache.set(citation.id, resolved);
    pendingResolutions.delete(citation.id);
    resolverState.textContent = 'resolver: idle';
    updateDecorations();
    return resolved;
  });

  pendingResolutions.set(citation.id, promise);
  return promise;
}

function getCitationAtOffset(offset: number): ParsedCitation | undefined {
  return latestCitations.find((citation) => offset >= citation.start && offset <= citation.end);
}

function hideCitationBubble() {
  citationBubble.classList.add('hidden');
  citationBubble.setAttribute('aria-hidden', 'true');
}

function showCitationBubble(citation: ParsedCitation, event: MouseEvent, resolved?: ResolvedCitation) {
  citationBubble.innerHTML = renderBubble(citation, resolved);
  citationBubble.classList.remove('hidden');
  citationBubble.setAttribute('aria-hidden', 'false');

  const editorRect = editorContainer.getBoundingClientRect();
  const bubbleRect = citationBubble.getBoundingClientRect();
  const left = Math.min(
    Math.max(event.clientX - editorRect.left + 12, 12),
    Math.max(12, editorRect.width - bubbleRect.width - 12)
  );
  const top = Math.min(
    Math.max(event.clientY - editorRect.top + 18, 12),
    Math.max(12, editorRect.height - bubbleRect.height - 12)
  );

  citationBubble.style.left = `${left}px`;
  citationBubble.style.top = `${top}px`;
}

function updateDiagnosticsSummary(reason: string) {
  diagnosticsLogCounter += 1;
  if (diagnosticsLogCounter % 5 !== 0) {
    return;
  }

  console.table({
    reason,
    queueMs: Number(lastWorkerQueueDelayMs.toFixed(1)),
    workerMs: Number(lastWorkerRoundTripMs.toFixed(1)),
    decorateMs: Number(lastDecorationMs.toFixed(1)),
    updateListenerMs: Number(longestUpdateListenerMs.toFixed(1)),
    selectionDispatchMs: Number(longestSelectionDispatchMs.toFixed(1)),
    maxFrameGapMs: Number(maxFrameGapMs.toFixed(1)),
    textLength: latestText.length,
    citations: latestCitations.length
  });
}

let lastAnimationFrameAt = performance.now();
function monitorFrameGap(now: number) {
  const gap = now - lastAnimationFrameAt;
  lastAnimationFrameAt = now;
  maxFrameGapMs = Math.max(maxFrameGapMs * 0.9, gap);
  frameJank.textContent = `frame: ${maxFrameGapMs.toFixed(1)} ms`;
  window.requestAnimationFrame(monitorFrameGap);
}
window.requestAnimationFrame(monitorFrameGap);

applyTheme((localStorage.getItem('citation-demo-theme') as ThemeName | null) ?? 'dark');
themeDarkButton.addEventListener('click', () => applyTheme('dark'));
themeLightButton.addEventListener('click', () => applyTheme('light'));

const editor = new EditorView({
  state: EditorState.create({
    doc: SAMPLE_TEXT,
    extensions: [
      citationDecorations,
      EditorView.lineWrapping,
      EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '15px',
          backgroundColor: 'transparent',
          color: 'var(--text-main)'
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          lineHeight: '24px',
          overflow: 'auto'
        },
        '.cm-content': {
          padding: '16px 0'
        },
        '.cm-focused': {
          outline: 'none'
        },
        '.cm-line': {
          padding: '0 16px'
        },
        '.cm-cursor': {
          borderLeftColor: 'var(--cursor-color)'
        },
        '.cm-selectionBackground, ::selection': {
          backgroundColor: 'var(--selection-bg) !important'
        }
      }),
      EditorState.allowMultipleSelections.of(false),
      EditorView.updateListener.of((update) => {
        const startedAt = performance.now();
        if (!update.docChanged) {
          if (update.selectionSet) {
            longestSelectionDispatchMs = Math.max(longestSelectionDispatchMs * 0.9, performance.now() - startedAt);
          }
          return;
        }

        const changes: Array<{ from: number; to: number; insertedText: string }> = [];
        for (const transaction of update.transactions) {
          transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({
              from: fromA,
              to: toA,
              insertedText: inserted.toString()
            });
          });
        }

        longestUpdateListenerMs = Math.max(longestUpdateListenerMs * 0.9, performance.now() - startedAt);
        scheduleParse(changes);
      })
    ]
  }),
  parent: editorContainer
});

editor.dom.addEventListener('mousedown', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) {
    hideCitationBubble();
    return;
  }

  const position = editor.posAtDOM(target, 0);
  const citation = getCitationAtOffset(position);
  if (!citation) {
    lastPinnedCitationId = undefined;
    hideCitationBubble();
    return;
  }

  const isRepeatedClick = lastPinnedCitationId === citation.id;
  lastPinnedCitationId = citation.id;
  renderSidebar(citation, resolutionCache.get(citation.id));
  if (isRepeatedClick) {
    showCitationBubble(citation, event, resolutionCache.get(citation.id));
  } else {
    hideCitationBubble();
  }

  void resolveAndRefresh(citation).then((resolved) => {
    renderSidebar(citation, resolved);
    if (isRepeatedClick) {
      showCitationBubble(citation, event, resolved);
    }
  });
});

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const response = event.data;

  if (response.version !== version) {
    return;
  }

  latestCitations = response.citations;
  citationsCount.textContent = `${latestCitations.length} citation${latestCitations.length === 1 ? '' : 's'}`;
  lastWorkerRoundTripMs = performance.now() - pendingParseSentAt;
  workerLatency.textContent = `worker: ${response.durationMs.toFixed(1)} ms / ${lastWorkerRoundTripMs.toFixed(1)} ms`;
  statusText.textContent = latestCitations.length > 0
    ? `Detected ${latestCitations.length} citation${latestCitations.length === 1 ? '' : 's'}.`
    : 'No citation detected in the current text.';

  updateDecorations();
  updateDiagnosticsSummary('worker');
};

worker.onerror = (error) => {
  statusText.textContent = `Worker error: ${error.message}`;
};

for (const button of document.querySelectorAll<HTMLButtonElement>('.sample-button')) {
  button.addEventListener('click', () => {
    const sample = button.dataset.sample;
    const nextText = sample === 'judgment' ? judgmentSample : SAMPLE_TEXT;

    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: nextText
      }
    });
  });
}

scheduleParse([{ from: 0, to: 0, insertedText: latestText }]);
