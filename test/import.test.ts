import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { runImport, rowMarkerId } from '../src/import/run.js';
import { parseWorkbook } from '../src/import/xlsx.js';
import { fakeContext } from './fake-github.js';

const HEADER = [
  'Empresa',
  'Vaga/Cargo',
  'Link da Vaga',
  'Data da Candidatura',
  'Status',
  'Etapa mais avançada',
  'Data de Retorno',
  'Dias até Retorno',
  'Fonte',
  'Contratação',
  'Salário Pretendido',
  'Salário Oferecido',
  'Observações',
];

function workbook(rows: unknown[][]): ExcelJS.Workbook {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Métricas').addRow(['Total de candidaturas', 22]);
  const sheet = book.addWorksheet('Candidaturas');
  sheet.addRow(HEADER);
  rows.forEach((row) => sheet.addRow(row));
  return book;
}

const ROWS: unknown[][] = [
  [
    'Luby', 'Senior QA', 'https://luby.inhire.app/vagas/1?utm_source=li', new Date(Date.UTC(2026, 8, 1)),
    'Entrevista Técnica', 'Entrevista RH', new Date(Date.UTC(2026, 8, 8)), '', 'LinkedIn', 'Cooperado, PJ',
    'R$ 18.000,00', '', 'Gostei da conversa',
  ],
  ['Radix', 'SDET', 'https://radix.inhire.app/vagas/2', '05/09/2026', 'Rejeitado', '', '', '', 'InHire', 'CLT', 15000, 14000, ''],
  ['Acme', 'QA Lead', '', '', 'Algo estranho', '', '', '', '', '', '', '', ''],
  [null, null],
];

describe('parseWorkbook', () => {
  it('maps the spreadsheet columns, statuses and values', async () => {
    const { rows, warnings } = parseWorkbook(workbook(ROWS));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      company: 'Luby',
      role: 'Senior QA',
      link: 'https://luby.inhire.app/vagas/1',
      appliedOn: '2026-09-01',
      status: 'tech-interview',
      furthestStage: 'hr-interview',
      responseDate: '2026-09-08',
      daysToResponse: 7,
      source: 'linkedin',
      contracts: ['Cooperado', 'PJ'],
      targetSalary: 18000,
      currency: 'BRL',
      notes: 'Gostei da conversa',
    });
    expect(rows[1]).toMatchObject({ appliedOn: '2026-09-05', status: 'rejected', offeredSalary: 14000, targetSalary: 15000 });
    expect(rows[1]?.furthestStage).toBeUndefined();
    expect(rows[2]).toMatchObject({ company: 'Acme', status: 'applied', link: undefined });
    expect(warnings).toEqual(['Row 4: unknown status "Algo estranho"; imported as "applied"']);
  });

  it('fails clearly when the sheet is not the expected one', () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('x').addRow(['a', 'b']);
    expect(() => parseWorkbook(book)).toThrowError(/Empresa/);
  });
});

describe('runImport', () => {
  const { rows } = parseWorkbook(workbook(ROWS));

  it('creates one issue per row, closes the ones with an outcome and writes the fields', async () => {
    const { ctx, issues, fieldWrites } = fakeContext();
    const result = await runImport(ctx, rows, { delayMs: 0 });

    expect(result).toEqual({ created: 3, skipped: 0 });
    const created = issues.create.mock.calls.map((call) => call[0] as { title: string; labels: string[]; body: string });
    expect(created.map((issue) => issue.title)).toEqual(['[Luby] Senior QA', '[Radix] SDET', '[Acme] QA Lead']);
    expect(created[0]?.labels).toEqual(['status:tech-interview', 'found:linkedin', 'contract:cooperado', 'contract:pj']);
    expect(created[0]?.body).toContain(`<!-- job-radar:id=${rowMarkerId(rows[0]!)} -->`);
    expect(created[2]?.body.split('\n')[0]).toBe('**Apply:** —');

    // only the rejected row (issue #102) is closed
    const closed = issues.update.mock.calls.map((call) => call[0] as { issue_number: number; state_reason: string });
    expect(closed).toEqual([expect.objectContaining({ issue_number: 102, state_reason: 'completed' })]);
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 101, body: 'Gostei da conversa' }));

    const writes = fieldWrites();
    expect(writes).toContainEqual(['F_applied', { date: '2026-09-01' }]);
    expect(writes).toContainEqual(['F_response', { date: '2026-09-08' }]);
    expect(writes).toContainEqual(['F_days', { number: 7 }]);
    expect(writes).toContainEqual(['F_furthest', { singleSelectOptionId: 'O_HR interview' }]);
    expect(writes).toContainEqual(['F_offered', { number: 14000 }]);
  });

  it('skips rows that were already imported', async () => {
    const existing = [{ body: `old\n\n<!-- job-radar:id=${rowMarkerId(rows[0]!)} -->` }, { body: null, pull_request: {} }];
    const { ctx, issues } = fakeContext({ existingIssues: existing });
    const result = await runImport(ctx, rows, { delayMs: 0 });

    expect(result).toEqual({ created: 2, skipped: 1 });
    expect(issues.create).toHaveBeenCalledTimes(2);
  });

  it('writes nothing on a dry run', async () => {
    const { ctx, issues, graphql } = fakeContext();
    const result = await runImport(ctx, rows, { dryRun: true });

    expect(result.created).toBe(3);
    expect(issues.create).not.toHaveBeenCalled();
    expect(graphql).not.toHaveBeenCalled();
  });
});
