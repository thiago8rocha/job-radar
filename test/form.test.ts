import { describe, expect, it } from 'vitest';
import { detectCurrency, parseAmount, parseJobForm } from '../src/commands/form.js';

const BODY = `### Company

Luby

### Role

Senior QA Automation Engineer

### Application link

https://luby.inhire.app/vagas/abc?utm_source=x

### Contract

CLT, PJ

### Compensation

R$ 15.000,00

### Currency

_No response_

### Contact

Recruiter

### Notes

Recruiter said the process has 3 stages.
`;

describe('parseJobForm', () => {
  it('reads the sections GitHub renders for an issue form', () => {
    expect(parseJobForm(BODY)).toEqual({
      company: 'Luby',
      role: 'Senior QA Automation Engineer',
      link: 'https://luby.inhire.app/vagas/abc?utm_source=x',
      contract: ['CLT', 'PJ'],
      compensation: 'R$ 15.000,00',
      contact: 'Recruiter',
      notes: 'Recruiter said the process has 3 stages.',
    });
  });

  it('returns undefined when a required field is missing', () => {
    expect(parseJobForm('### Company\n\nLuby\n\n### Role\n\n_No response_\n')).toBeUndefined();
    expect(parseJobForm('just some text')).toBeUndefined();
  });

  it('handles CRLF line endings', () => {
    expect(parseJobForm(BODY.replace(/\n/g, '\r\n'))?.company).toBe('Luby');
  });
});

describe('parseAmount', () => {
  it.each([
    ['R$ 15.000,00', 15000],
    ['USD 8,000', 8000],
    ['12.500', 12500],
    ['12,5k', 12500],
    ['10k', 10000],
    ['1234.5', 1234.5],
    ['15000', 15000],
  ])('%s → %d', (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it('gives up on ranges and empty text', () => {
    expect(parseAmount('10k - 15k')).toBeUndefined();
    expect(parseAmount('to be discussed')).toBeUndefined();
    expect(parseAmount(undefined)).toBeUndefined();
  });
});

describe('detectCurrency', () => {
  it.each([
    ['R$ 10.000', 'BRL'],
    ['US$ 5k', 'USD'],
    ['USD 5,000', 'USD'],
    ['€4000', 'EUR'],
    ['10000', undefined],
  ])('%s → %s', (text, expected) => {
    expect(detectCurrency(text)).toBe(expected);
  });
});
