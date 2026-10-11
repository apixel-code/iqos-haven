/**
 * Search term normalization (roadmap step 60, architecture §5 "Search": bounded term length).
 * Everything the search SQL receives from a shopper's text goes through here first: lower-cased
 * letters and digits only, a bounded number of bounded tokens. Punctuation, operators and control
 * characters never reach the query text.
 */
export const SEARCH_LIMITS = { maxLength: 64, maxTokens: 6, maxTokenLength: 32 } as const;

export interface SearchTerm {
  /** Normalized text, tokens joined by one space; "" when nothing searchable was typed. */
  readonly text: string;
  readonly tokens: readonly string[];
}

export function normalizeSearchTerm(input: string | null | undefined): SearchTerm {
  const tokens = (input ?? "")
    .slice(0, SEARCH_LIMITS.maxLength * 4)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) => token.slice(0, SEARCH_LIMITS.maxTokenLength))
    .slice(0, SEARCH_LIMITS.maxTokens);
  let text = "";
  const kept: string[] = [];
  for (const token of tokens) {
    const next = text ? `${text} ${token}` : token;
    if (next.length > SEARCH_LIMITS.maxLength) break;
    text = next;
    kept.push(token);
  }
  return { text, tokens: kept };
}

/**
 * Prefix query for PostgreSQL `to_tsquery('simple', …)`: every token must match as a word prefix.
 * Safe to pass as a bound parameter because tokens contain only letters and digits.
 */
export function prefixTsQuery(term: SearchTerm): string {
  return term.tokens.map((token) => `'${token}':*`).join(" & ");
}
