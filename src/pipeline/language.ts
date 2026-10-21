import { containsTerm, normalizeText } from '../util/text.js';

/** Bullets, line breaks and sentence ends: a language requirement is judged inside one of these pieces. */
const SEGMENT = /[\n\r•·*;|]+|(?<=[.!?])\s+/;

const REQUIRED = /\b(required|requirement|must|mandatory|fluent|fluency|advanced|native|bilingual|proficien\w*|obrigatori[oa]|necessari[oa]|exigid[oa]|avancado|fluente|nativo|bilingue|imprescindible|indispensable|requerido|avanzado)\b/;
const OPTIONAL = /\b(plus|preferred|preferable|desirable|bonus|advantage|nice to have|beneficial|differential|diferencial|desejavel|desejaveis|ventaja|deseable)\b/;
const ENGLISH_OR_PORTUGUESE = /\b(english|ingles|portuguese|portugues)\b/;
const ALTERNATIVE = /\b(or|ou|and\/or|e\/ou)\b/;

/** True when the segment offers English or Portuguese as an alternative ("English or Spanish"). */
function hasAlternative(segment: string): boolean {
  return ENGLISH_OR_PORTUGUESE.test(segment) && ALTERNATIVE.test(segment);
}

/**
 * The first language from `languages` that the text asks for as a requirement, or undefined.
 * "Fluent Spanish" and "Idioma necessário: Espanhol avançado" count; "Spanish is a plus",
 * "English or Spanish" and a bare mention do not.
 */
export function requiredLanguage(text: string, languages: string[]): string | undefined {
  if (languages.length === 0) return undefined;
  for (const piece of text.split(SEGMENT)) {
    const language = languages.find((candidate) => containsTerm(piece, candidate));
    if (!language) continue;
    const segment = normalizeText(piece);
    if (OPTIONAL.test(segment) || hasAlternative(segment)) continue;
    if (REQUIRED.test(segment)) return language;
  }
  return undefined;
}
