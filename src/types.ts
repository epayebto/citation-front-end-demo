export interface ParsedCitation {
  id: string;
  abbreviation: string;
  articleNumber: string;
  rawSpan: string;
  start: number;
  end: number;
  srNumber?: string;
  paragraph?: string;
  letter?: string;
  number?: string;
  sentence?: string;
}

export interface WorkerRequest {
  version: number;
  fullText: string;
  changes?: Array<{
    from: number;
    to: number;
    insertedText: string;
  }>;
  selectionStart?: number;
}

export interface WorkerResponse {
  version: number;
  citations: ParsedCitation[];
  durationMs: number;
}

export interface ArticlePreviewPayload {
  language: string;
  title: string;
  articleLabel: string;
  html: string;
  sourceUrl: string;
}

export interface ResolvedCitation {
  citationId: string;
  canonicalKey: string;
  resolved: boolean;
  displayLabel: string;
  lawTitle?: string;
  srNumber?: string;
  payloads?: Record<string, ArticlePreviewPayload>;
  reason?: string;
}
