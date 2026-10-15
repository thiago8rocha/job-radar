import { describe, expect, it } from 'vitest';
import { brasiliaHours } from '../src/pipeline/timezone.js';

const OCTOBER = new Date('2026-10-15T12:00:00Z'); // US and Europe on summer time
const DECEMBER = new Date('2026-12-15T12:00:00Z'); // winter time; Brazil has no DST

describe('brasiliaHours', () => {
  it('converts the hours using the zone offset on the collection date', () => {
    expect(brasiliaHours('Core hours 9am–5pm ET.', OCTOBER)).toBe('9am–5pm ET → 10am–6pm Brasília time');
    expect(brasiliaHours('Core hours 9am–5pm ET.', DECEMBER)).toBe('9am–5pm ET → 11am–7pm Brasília time');
  });

  it('keeps 24-hour times in 24-hour format', () => {
    expect(brasiliaHours('Working hours: 10:00-18:00 CET', OCTOBER)).toBe('10:00-18:00 CET → 05:00–13:00 Brasília time');
  });

  it('infers the period of the start time and handles hours that cross midnight in Brasília', () => {
    expect(brasiliaHours('Available 9-5pm PT', OCTOBER)).toBe('9-5pm PT → 1pm–9pm Brasília time');
    expect(brasiliaHours('4pm to 11:30pm UTC', OCTOBER)).toBe('4pm to 11:30pm UTC → 1pm–8:30pm Brasília time');
  });

  it('ignores text that is not a schedule or is already in Brasília time', () => {
    expect(brasiliaHours('5-10 PT years of experience', OCTOBER)).toBeUndefined();
    expect(brasiliaHours('10:00-18:00 BRT', OCTOBER)).toBeUndefined();
    expect(brasiliaHours('Flexible hours', OCTOBER)).toBeUndefined();
  });
});
