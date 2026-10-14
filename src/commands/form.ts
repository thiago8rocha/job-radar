import { CURRENCIES, CONTACTS } from '../domain/fields.js';

export interface JobForm {
  company: string;
  role: string;
  link: string;
  contract: string[];
  compensation?: string;
  currency?: string;
  contact?: string;
  notes?: string;
}

const NO_RESPONSE = /^_?No response_?$/i;

/** Splits the markdown GitHub renders for an issue form: `### Label` followed by the value. */
export function parseSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.replace(/\r\n/g, '\n').split(/^### +(.+?)\s*$/m);
  // parts = [preamble, heading1, value1, heading2, value2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const value = (parts[i + 1] ?? '').trim();
    sections.set(parts[i]!.trim().toLowerCase(), NO_RESPONSE.test(value) ? '' : value);
  }
  return sections;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;\n]| e | and /i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((candidate) => candidate.toLowerCase() === value?.trim().toLowerCase());
}

/** Parses the body of an issue created from `.github/ISSUE_TEMPLATE/job.yml`. */
export function parseJobForm(body: string): JobForm | undefined {
  const sections = parseSections(body);
  const company = sections.get('company');
  const role = sections.get('role');
  const link = sections.get('application link');
  if (!company || !role || !link) return undefined;

  const currency = oneOf(sections.get('currency'), CURRENCIES);
  const contact = oneOf(sections.get('contact'), CONTACTS);
  return {
    company,
    role,
    link,
    contract: splitList(sections.get('contract')),
    compensation: sections.get('compensation') || undefined,
    ...(currency ? { currency } : {}),
    ...(contact ? { contact } : {}),
    notes: sections.get('notes') || undefined,
  };
}

/**
 * Extracts the number from a compensation text such as "R$ 12.500,00", "12,5k" or "USD 8,000".
 * Returns undefined when it is not a single amount (ranges are kept in the issue body only).
 */
export function parseAmount(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const matches = text.match(/\d[\d.,]*\s*k?/gi);
  if (!matches || matches.length !== 1) return undefined;

  let raw = matches[0]!.trim().toLowerCase();
  const thousands = raw.endsWith('k');
  if (thousands) raw = raw.slice(0, -1).trim();

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  const decimalSeparator = lastComma > lastDot ? ',' : lastDot > lastComma ? '.' : undefined;
  let normalized: string;
  if (decimalSeparator) {
    const index = raw.lastIndexOf(decimalSeparator);
    const decimals = raw.length - index - 1;
    // "12.500" / "12,500" has a thousands separator; "12.5" / "12,50" has decimals
    normalized =
      decimals === 3 && !thousands
        ? raw.replace(/[.,]/g, '')
        : raw.slice(0, index).replace(/[.,]/g, '') + '.' + raw.slice(index + 1);
  } else {
    normalized = raw;
  }
  const value = Number(normalized) * (thousands ? 1000 : 1);
  return Number.isFinite(value) ? value : undefined;
}

/** Currency hinted by the compensation text, e.g. "R$" → BRL, "US$" or "USD" → USD. */
export function detectCurrency(text: string | undefined): (typeof CURRENCIES)[number] | undefined {
  if (!text) return undefined;
  if (/R\$|\bBRL\b|\breais\b/i.test(text)) return 'BRL';
  if (/US\$|\bUSD\b|\bdollars?\b|\$/i.test(text)) return 'USD';
  if (/€|\bEUR\b|\beuros?\b/i.test(text)) return 'EUR';
  return undefined;
}
