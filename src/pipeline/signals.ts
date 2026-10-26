import { normalizeText, truncate } from '../util/text.js';

export type SignalKind = 'internal' | 'intermediary' | 'scam';

export interface Signal {
  kind: SignalKind;
  quote: string;
}

const SEGMENT = /[\n\r•·*;|]+|(?<=[.!?])\s+/;

const PATTERNS: Array<{ kind: SignalKind; pattern: RegExp }> = [
  {
    kind: 'internal',
    pattern:
      /\b(internal (candidates?|applicants?|hires?|recruitment|selection|opportunity|job posting|only)|only (open )?(to|for) (current |existing )?employees|selecao interna|vaga interna|recrutamento interno|processo seletivo interno|exclusiv[oa] (para|a|de) (colaboradores|funcionarios))\b/,
  },
  {
    kind: 'intermediary',
    pattern:
      /\b(on behalf of (a|an|our|one of our)\b|(hiring|recruiting|searching) for (a|an|one of our) (client|partner|customer)|our (client|partner company) is|nosso cliente (e|esta|atua)|em nome de (uma|um|nosso)|empresa parceira|cliente confidencial|confidential (client|company))/,
  },
  {
    kind: 'scam',
    pattern:
      /\b(pix\b.*\b(antecipad|taxa|deposit)|(taxa|pagamento) (de )?(inscricao|adesao|cadastro|treinamento|antecipad[oa])|(registration|training|application) fee|pay (a |an )?(fee|deposit)|send (us )?your (bank|banking) (account|details)|(envie|informe|forneca) (seus )?dados bancarios|(contato|contact)\b[^.]{0,40}\b(somente|apenas|only|exclusivamente)\b[^.]{0,20}\b(whatsapp|telegram)|(whatsapp|telegram) only|western union|gift cards?)\b/,
  },
];

/** A scam pattern inside a warning ("we will never ask you to pay a fee") is the opposite of a signal. */
const NEGATED = /\b(never|nunca|jamais|not|no|nao|beware|cuidado|fraud\w*|golpe\w*|scam\w*)\b/;

/** One signal per kind at most, the first sentence that raises it. They flag a posting; none of them discards it. */
export function detectSignals(text: string): Signal[] {
  const found = new Map<SignalKind, Signal>();
  for (const piece of text.split(SEGMENT)) {
    const segment = normalizeText(piece);
    for (const { kind, pattern } of PATTERNS) {
      if (!found.has(kind) && pattern.test(segment) && !(kind === 'scam' && NEGATED.test(segment))) {
        found.set(kind, { kind, quote: truncate(piece.replace(/\s+/g, ' ').trim(), 200) });
      }
    }
  }
  return [...found.values()];
}
