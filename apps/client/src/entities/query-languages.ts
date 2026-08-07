export interface QueryLanguageDefinition {
  id: string;
  label: string;
  sourceLanguage: string;
}

export const DEFAULT_QUERY_LANGUAGE_ID = "sparql-1.1/neoseq-v1";

export const QUERY_LANGUAGES: QueryLanguageDefinition[] = [
  {
    id: DEFAULT_QUERY_LANGUAGE_ID,
    label: "SPARQL 1.1",
    sourceLanguage: "sparql",
  },
];

export function queryLanguage(id: string): QueryLanguageDefinition | undefined {
  return QUERY_LANGUAGES.find((language) => language.id === id);
}
