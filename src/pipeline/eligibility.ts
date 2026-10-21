import { normalizeText } from '../util/text.js';

/** Regions a job can be open to. Anything else is `other` (an explicit non-accepted place). */
export type Region = 'worldwide' | 'latam' | 'americas' | 'brazil' | 'other';

const LATAM_COUNTRIES = [
  'argentina', 'chile', 'colombia', 'mexico', 'peru', 'uruguay', 'paraguay', 'bolivia', 'ecuador',
  'venezuela', 'costa rica', 'panama', 'guatemala', 'dominican republic', 'el salvador', 'honduras',
];

const WORLDWIDE = /\b(worldwide|anywhere|global|work from anywhere|world wide)\b/;
const LATAM = /\b(latam|latin america|america latina)\b/;
const AMERICAS = /\b(americas|the americas)\b/;
const BRAZIL = /\b(brazil|brasil)\b/;
const OTHER_PLACES =
  /\b(us|usa|u s|united states|canada|uk|united kingdom|england|ireland|europe|european union|eu|emea|apac|asia|india|china|japan|australia|new zealand|germany|france|spain|portugal|italy|netherlands|poland|romania|ukraine|turkey|israel|africa|nigeria|kenya|south africa|singapore|philippines|pakistan|bangladesh|vietnam|indonesia)\b/;
const REMOTE_ONLY = /\b(remote|remoto|home office|distributed)\b/;

/** Two-letter country codes some sources use as the whole location (InHire: `BR`). */
function fromCountryCode(text: string): Region | undefined {
  const code = text.trim();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  return code === 'BR' ? 'brazil' : 'other';
}

/**
 * Regions a location text opens the job to. "Remote - Brazil" → brazil; "Remote, US or Canada" →
 * other; a bare "Remote" or "Anywhere" → worldwide. Brazil also counts as LATAM and the Americas.
 */
export function regionsOf(text: string): Region[] {
  const byCode = fromCountryCode(text);
  if (byCode) return byCode === 'brazil' ? ['brazil', 'latam', 'americas'] : ['other'];

  const value = ` ${normalizeText(text)} `;
  const regions = new Set<Region>();
  if (WORLDWIDE.test(value)) regions.add('worldwide');
  if (LATAM.test(value) || LATAM_COUNTRIES.some((country) => value.includes(` ${country} `))) {
    regions.add('latam');
    regions.add('americas');
  }
  if (AMERICAS.test(value)) regions.add('americas');
  if (BRAZIL.test(value)) {
    regions.add('brazil');
    regions.add('latam');
    regions.add('americas');
  }
  if (OTHER_PLACES.test(value)) regions.add('other');
  if (regions.size === 0 && REMOTE_ONLY.test(value)) regions.add('worldwide');
  return [...regions];
}

/**
 * True when `phrase` appears in the text and is not followed by an accepted place:
 * "must reside in the US" rejects, "must reside in Brazil" does not.
 */
function rejectedBy(haystack: string, phrase: string, accepted: Set<string>): boolean {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return false;
    const after = haystack.slice(index + needle.length, index + needle.length + 40);
    const followedByAccepted = regionsOf(after).some((region) => region !== 'other' && region !== 'worldwide' && accepted.has(region));
    if (!followedByAccepted) return true;
    from = index + needle.length;
  }
}

const BASED_IN = /\b(?:looking for|seeking|searching for|hiring)\b[^.\n]{0,150}?\bbased in (?:the )?([^.\n*,;()]{2,40})/i;

/**
 * Aggregators such as jobgether list dozens of countries a candidate may apply from, while the text
 * says where the role really is: "Our partner is looking for a QA Engineer based in Canada".
 */
function statedBase(description: string): string | undefined {
  return BASED_IN.exec(description)?.[1]?.trim();
}

export interface EligibilityInput {
  locations: string[];
  restrictions?: string[];
  description: string;
}

export interface EligibilityResult {
  ok: boolean;
  /** Short reason when the job is not eligible. */
  reason?: string;
}

/**
 * Geographic eligibility. A job passes when at least one of its locations (or its explicit
 * restriction list) is in an accepted region. No location at all is treated as worldwide for a
 * remote job. `reject` phrases ("US only", "must reside in") discard the job wherever they appear.
 */
export function checkEligibility(
  job: EligibilityInput,
  acceptRegions: string[],
  rejectPhrases: string[],
): EligibilityResult {
  const accepted = new Set(acceptRegions.map((region) => region.toLowerCase()));
  const haystack = normalizeText(`${job.locations.join(' ')} ${job.description}`);
  const phrase = rejectPhrases.find((candidate) => rejectedBy(haystack, candidate, accepted));
  if (phrase) return { ok: false, reason: `eligibility: "${phrase}"` };

  const base = statedBase(job.description);
  const baseRegions = base ? regionsOf(base) : [];
  if (base && baseRegions.length > 0 && !baseRegions.some((region) => region !== 'other' && accepted.has(region))) {
    return { ok: false, reason: `eligibility: based in ${base}` };
  }

  const sources = job.restrictions && job.restrictions.length > 0 ? job.restrictions : job.locations;
  const regions = sources.length === 0 ? ['worldwide' as Region] : sources.flatMap(regionsOf);

  if (regions.some((region) => region !== 'other' && accepted.has(region))) return { ok: true };
  return { ok: false, reason: 'eligibility: region not accepted' };
}
