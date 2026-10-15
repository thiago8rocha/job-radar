const BRASILIA = 'America/Sao_Paulo';

/** Zone names that postings use, mapped to IANA zones (so daylight saving follows the date). */
const ZONES: Record<string, string> = {
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  utc: 'UTC', gmt: 'UTC',
  bst: 'Europe/London', uk: 'Europe/London',
  cet: 'Europe/Paris', cest: 'Europe/Paris',
  eet: 'Europe/Athens', eest: 'Europe/Athens',
};

/** Already Brasília time: nothing to convert. */
const BRASILIA_NAMES = new Set(['brt', 'brasilia', 'brasília']);

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;
const ZONE_NAMES = [...Object.keys(ZONES), ...BRASILIA_NAMES].join('|');
const RANGE = new RegExp(
  String.raw`\b${TIME}\s*(?:-|–|—|to|until|até|às)\s*${TIME}\s*\(?\b(${ZONE_NAMES})\b(?:\s+time)?\)?`,
  'i',
);

interface Clock {
  hour: number;
  minute: number;
  meridiem?: 'am' | 'pm';
}

function meridiemOf(value: string | undefined): 'am' | 'pm' | undefined {
  return value ? (value.toLowerCase().startsWith('a') ? 'am' : 'pm') : undefined;
}

function to24(clock: Clock): number {
  if (!clock.meridiem) return clock.hour;
  return (clock.hour % 12) + (clock.meridiem === 'pm' ? 12 : 0);
}

/** Offset of `zone` from UTC at `instant`, in minutes. */
function offsetMinutes(zone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** The instant at which the wall clock of `zone` reads `hour:minute` on the calendar day of `day`. */
function instantAt(zone: string, day: Date, hour: number, minute: number): Date {
  const [year, month, date] = [day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()];
  let guess = new Date(Date.UTC(year, month, date, hour, minute));
  for (let i = 0; i < 2; i++) {
    guess = new Date(Date.UTC(year, month, date, hour, minute) - offsetMinutes(zone, guess) * 60000);
  }
  return guess;
}

function clockInBrasilia(instant: Date): { hour: number; minute: number } {
  const minutes = (instant.getUTCHours() * 60 + instant.getUTCMinutes() + offsetMinutes(BRASILIA, instant) + 1440) % 1440;
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

function format(hour: number, minute: number, twelveHour: boolean): string {
  const mm = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  if (!twelveHour) return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}${mm}${hour < 12 ? 'am' : 'pm'}`;
}

/**
 * Finds working hours with a time zone in a job description ("9am–5pm ET", "10:00-18:00 CET") and
 * returns them converted to Brasília time on `day`, e.g. `9am–5pm ET → 10am–6pm Brasília time`.
 * The zone is resolved on that date, because the US and Europe observe daylight saving and Brazil does not.
 * Returns undefined when the text states no hours, or they are already in Brasília time.
 */
export function brasiliaHours(text: string, day: Date): string | undefined {
  const match = RANGE.exec(text);
  if (!match) return undefined;
  const [whole, h1, m1, mer1, h2, m2, mer2, zoneName] = match;
  if (BRASILIA_NAMES.has(zoneName!.toLowerCase())) return undefined;
  const zone = ZONES[zoneName!.toLowerCase()];
  if (!zone) return undefined;

  const hasMinutes = Boolean(m1 || m2);
  const hasMeridiem = Boolean(mer1 || mer2);
  if (!hasMinutes && !hasMeridiem) return undefined; // "5-10 PT" is not a schedule

  const end: Clock = { hour: Number(h2), minute: Number(m2 ?? 0), meridiem: meridiemOf(mer2) };
  const start: Clock = { hour: Number(h1), minute: Number(m1 ?? 0), meridiem: meridiemOf(mer1) };
  if (!start.meridiem && end.meridiem) {
    // "9-5pm": the start borrows the end's period unless that would make it later than the end
    start.meridiem = start.hour > end.hour ? 'am' : end.meridiem;
  }
  if (start.hour > 24 || end.hour > 24 || start.minute > 59 || end.minute > 59) return undefined;

  const converted = [start, end].map((clock) => clockInBrasilia(instantAt(zone, day, to24(clock), clock.minute)));
  const twelveHour = hasMeridiem;
  const original = whole.replace(/\s+/g, ' ').trim().replace(/[()]/g, '');
  const range = `${format(converted[0]!.hour, converted[0]!.minute, twelveHour)}–${format(converted[1]!.hour, converted[1]!.minute, twelveHour)}`;
  return `${original} → ${range} Brasília time`;
}
