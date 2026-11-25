import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCompaniesText } from '../src/discovery/companies-file.js';
import { importCompaniesFiles, LASTROUND_COLUMNS, mergeIntoDirectory, parseCsv, rowsFromCsv, rowsFromUrls } from '../src/import/companies.js';

const csv = new URL('./fixtures/lastround-sample.csv', import.meta.url);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'job-radar-import-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('csv', () => {
  it('reads quoted fields, doubled quotes and a BOM', () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('maps the LastRound columns and fails on a missing one', async () => {
    const text = await readFile(csv, 'utf8');
    expect(rowsFromCsv(text, LASTROUND_COLUMNS)[1]).toEqual({ ats: 'greenhouse', slug: 'beta', name: 'Beta, Ltd.' });
    expect(() => rowsFromCsv(text, { ...LASTROUND_COLUMNS, slug: 'nope' })).toThrow('no "nope" column');
  });
});

describe('mergeIntoDirectory', () => {
  it('adds new boards, skips listed ones and reports unknown ATS and empty slugs', async () => {
    const rows = rowsFromCsv(await readFile(csv, 'utf8'), LASTROUND_COLUMNS);
    const result = mergeIntoDirectory('', 'greenhouse: [Listed]\nashby: [listed]\n', rows);
    expect(result).toMatchObject({ added: 6, skipped: 1, unknownAts: { workday: 2 }, empty: 1 });
    const directory = parseCompaniesText(result.text);
    expect(directory.greenhouse).toEqual([{ slug: 'acme', name: 'Acme Inc' }, { slug: 'beta', name: 'Beta, Ltd.' }, { slug: 'quoteco', name: 'Quote "Q" Co' }]);
    expect(directory.lever).toEqual([{ slug: 'gamma', name: 'Gamma' }, { slug: 'deltaco', name: 'Delta' }]);
  });

  it('gives the same file when the same rows are imported twice', async () => {
    const rows = rowsFromCsv(await readFile(csv, 'utf8'), LASTROUND_COLUMNS);
    const first = mergeIntoDirectory('# cold list\n', '', rows);
    const second = mergeIntoDirectory(first.text, '', rows);
    expect(second.text).toBe(first.text);
    expect(second.added).toBe(0);
    expect(first.text.startsWith('# cold list')).toBe(true);
  });
});

describe('url list', () => {
  it('resolves career-page links and reports the ones it cannot', () => {
    const { rows, unresolved } = rowsFromUrls('# remote companies\nhttps://boards.greenhouse.io/acme/jobs/1\n\nhttps://jobs.lever.co/gamma\nhttps://example.com/careers\n');
    expect(rows).toEqual([{ ats: 'greenhouse', slug: 'acme' }, { ats: 'lever', slug: 'gamma' }]);
    expect(unresolved).toEqual(['https://example.com/careers']);
  });
});

describe('importCompaniesFiles', () => {
  it('writes the directory file and is idempotent', async () => {
    const directoryPath = join(dir, 'companies.directory.yml');
    const options = { csv: csv.pathname.replace(/^\/([A-Za-z]:)/, '$1'), directoryPath, companiesPath: join(dir, 'companies.yml'), log: () => undefined };
    await writeFile(options.companiesPath, 'ashby: [listed]\n');
    const first = await importCompaniesFiles(options);
    const written = await readFile(directoryPath, 'utf8');
    const second = await importCompaniesFiles(options);
    expect(first.added).toBe(6);
    expect(second.added).toBe(0);
    expect(await readFile(directoryPath, 'utf8')).toBe(written);
  });
});
