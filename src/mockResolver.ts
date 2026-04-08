import type { ParsedCitation, ResolvedCitation } from './types';

const lawByAbbreviation: Record<string, { srNumber: string; title: string }> = {
  ZGB: { srNumber: '210', title: 'Swiss Civil Code' },
  CC: { srNumber: '210', title: 'Code civil suisse' },
  OR: { srNumber: '220', title: 'Code of Obligations' },
  LTF: { srNumber: '173.110', title: 'Federal Supreme Court Act' }
};

const articleDatabase: Record<string, { title: string; de: string; fr: string; it: string }> = {
  '210|28': {
    title: 'Swiss Civil Code',
    de: 'Wer in seiner Persönlichkeit widerrechtlich verletzt wird, kann zu seinem Schutz gegen jeden, der an der Verletzung mitwirkt, das Gericht anrufen.',
    fr: 'Celui qui subit une atteinte illicite à sa personnalité peut agir en justice contre toute personne qui y participe.',
    it: 'Chiunque sia illecitamente leso nella sua personalità può chiedere al giudice protezione contro chiunque partecipi alla lesione.'
  },
  '220|41': {
    title: 'Code of Obligations',
    de: 'Wer einem andern widerrechtlich Schaden zufügt, sei es mit Absicht, sei es aus Fahrlässigkeit, wird ihm zum Ersatze verpflichtet.',
    fr: 'Celui qui cause, d’une manière illicite, un dommage à autrui, soit intentionnellement, soit par négligence, est tenu de le réparer.',
    it: 'Chiunque cagiona illecitamente ad altri un danno, sia con intenzione sia per negligenza, è tenuto a risarcirlo.'
  },
  '220|100bis': {
    title: 'Code of Obligations',
    de: 'Beispielhafter Demo-Text für Art. 100bis OR.',
    fr: 'Texte de démonstration pour l’art. 100bis CO.',
    it: 'Testo dimostrativo per l’art. 100bis CO.'
  },
  '173.110|190': {
    title: 'Federal Supreme Court Act',
    de: 'Bundesgesetze und Völkerrecht sind für das Bundesgericht und die anderen rechtsanwendenden Behörden massgebend.',
    fr: 'Le Tribunal fédéral et les autres autorités sont tenus d’appliquer les lois fédérales et le droit international.',
    it: 'Il Tribunale federale e le altre autorità applicano le leggi federali e il diritto internazionale.'
  }
};

const cache = new Map<string, Promise<ResolvedCitation>>();

function buildCanonicalKey(citation: ParsedCitation): string {
  if (citation.srNumber) {
    return `${citation.srNumber}|${citation.articleNumber || '*'}`;
  }
  return `${citation.abbreviation.toUpperCase()}|${citation.articleNumber.toLowerCase()}`;
}

export function resolveCitation(citation: ParsedCitation): Promise<ResolvedCitation> {
  const cacheKey = buildCanonicalKey(citation);
  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const promise = new Promise<ResolvedCitation>((resolve) => {
    window.setTimeout(() => {
      const lawRecord = citation.srNumber
        ? { srNumber: citation.srNumber, title: `Law SR ${citation.srNumber}` }
        : lawByAbbreviation[citation.abbreviation.toUpperCase()];

      if (!lawRecord) {
        resolve({
          citationId: citation.id,
          canonicalKey: cacheKey,
          resolved: false,
          displayLabel: citation.rawSpan,
          reason: `Unknown abbreviation: ${citation.abbreviation}`
        });
        return;
      }

      const articleKey = `${lawRecord.srNumber}|${citation.articleNumber}`;
      const record = articleDatabase[articleKey];

      if (!record) {
        resolve({
          citationId: citation.id,
          canonicalKey: cacheKey,
          resolved: false,
          displayLabel: citation.rawSpan,
          srNumber: lawRecord.srNumber,
          lawTitle: lawRecord.title,
          reason: `Law found, but article ${citation.articleNumber} is not present in the demo dataset.`
        });
        return;
      }

      resolve({
        citationId: citation.id,
        canonicalKey: cacheKey,
        resolved: true,
        displayLabel: citation.rawSpan,
        srNumber: lawRecord.srNumber,
        lawTitle: record.title,
        payloads: {
          de: {
            language: 'de',
            title: record.title,
            articleLabel: `Art. ${citation.articleNumber}`,
            html: `<p>${record.de}</p>`,
            sourceUrl: `https://www.fedlex.admin.ch/eli/cc/${lawRecord.srNumber}`
          },
          fr: {
            language: 'fr',
            title: record.title,
            articleLabel: `Art. ${citation.articleNumber}`,
            html: `<p>${record.fr}</p>`,
            sourceUrl: `https://www.fedlex.admin.ch/eli/cc/${lawRecord.srNumber}`
          },
          it: {
            language: 'it',
            title: record.title,
            articleLabel: `Art. ${citation.articleNumber}`,
            html: `<p>${record.it}</p>`,
            sourceUrl: `https://www.fedlex.admin.ch/eli/cc/${lawRecord.srNumber}`
          }
        }
      });
    }, 120);
  });

  cache.set(cacheKey, promise);
  return promise;
}
