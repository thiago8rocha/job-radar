const UNITS: Array<[RegExp, number]> = [
  [/^(minute|minuto|min)s?$/, 60_000],
  [/^(hour|hora|h)s?$/, 3_600_000],
  [/^(day|dia|d)s?$/, 86_400_000],
  [/^(week|semana|sem)s?$/, 7 * 86_400_000],
  [/^(month|mes|mês|meses)s?$/, 30 * 86_400_000],
];

/**
 * "3 days ago", "há 2 semanas", "30+ days ago", "yesterday" → ISO timestamp relative to `now`.
 * Undefined when the text is not a relative date, so the posting is not judged on a guess.
 */
export function relativeToIso(text: string | undefined, now: Date): string | undefined {
  const value = (text ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (/^(just now|now|agora|hoje|today)$/.test(value)) return now.toISOString();
  if (/^(yesterday|ontem)$/.test(value)) return new Date(now.getTime() - 86_400_000).toISOString();

  const match = /(\d+)\+?\s*([a-zçê]+)/.exec(value);
  if (!match) return undefined;
  const unit = UNITS.find(([pattern]) => pattern.test(match[2]!));
  return unit ? new Date(now.getTime() - Number(match[1]) * unit[1]).toISOString() : undefined;
}
