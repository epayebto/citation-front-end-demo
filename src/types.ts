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

export interface SubArticleFocus {
  eid: string;
  chapeau?: string;
  text: string;
}

export interface SubArticle {
  eid: string;
  type: 'paragraph' | 'item';
  num?: string;
  label?: string;
  chapeau?: string;
  text: string;
  items: SubArticle[];
}

export interface ArticlePreviewPayload {
  language: string;
  title: string;
  articleLabel: string;
  articleTitle?: string;
  hierarchyLabel?: string;
  excerpt: string;
  fullText: string;
  sourceUrl: string;
  subArticles: SubArticle[];
  focus?: SubArticleFocus;
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
