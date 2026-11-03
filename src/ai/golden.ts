export interface GoldenCase {
  id: string;
  title: string;
  company: string;
  description: string;
  /** The scores the candidate's own decision on this job allows: applied means 3 to 5, dropped for a hard reason means 1 to 2. */
  expect: { min: number; max: number };
  /** Where the expectation comes from, for people reading the file. */
  label: string;
}

export interface GoldenResult {
  total: number;
  agreed: number;
  rate: number;
  misses: Array<{ id: string; fit: number; expect: GoldenCase['expect'] }>;
}

/** Share of the scored cases whose fit falls inside what the candidate's decision allows. Cases without a score are left out. */
export function scoreGolden(cases: GoldenCase[], fits: Record<string, number>): GoldenResult {
  const scored = cases.filter((item) => fits[item.id] !== undefined);
  const misses = scored
    .filter((item) => fits[item.id]! < item.expect.min || fits[item.id]! > item.expect.max)
    .map((item) => ({ id: item.id, fit: fits[item.id]!, expect: item.expect }));
  const agreed = scored.length - misses.length;
  return { total: scored.length, agreed, rate: scored.length === 0 ? 0 : agreed / scored.length, misses };
}

/** Below this share of agreement the model is not good enough to keep (the live run exits with an error). */
export const MIN_AGREEMENT = 0.7;
