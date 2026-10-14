import ExcelJS from 'exceljs';
import { stageNumber, type Status } from '../domain/status.js';
import { slugify } from '../domain/labels.js';
import { parseAmount, detectCurrency } from '../commands/form.js';
import { canonicalUrl } from '../pipeline/url.js';

export interface ImportRow {
  rowNumber: number;
  company: string;
  role: string;
  link?: string;
  appliedOn?: string;
  status: Status;
  furthestStage?: Status;
  responseDate?: string;
  daysToResponse?: number;
  source?: string;
  contracts: string[];
  targetSalary?: number;
  offeredSalary?: number;
  currency?: 'BRL' | 'USD' | 'EUR';
  notes?: string;
}

export interface ParsedSheet {
  rows: ImportRow[];
  warnings: string[];
}

const STATUS_BY_NAME: Record<string, Status> = {
  nova: 'new',
  new: 'new',
  inscrito: 'applied',
  triagem: 'screening',
  'entrevista rh': 'hr-interview',
  'entrevista tecnica': 'tech-interview',
  'teste tecnico': 'take-home',
  proposta: 'offer',
  aprovado: 'hired',
  rejeitado: 'rejected',
  desisti: 'withdrawn',
};

/** Column headers as written in `controle_vagas.xlsx`, after `normalizeHeader`. */
const COLUMNS = {
  company: ['empresa'],
  role: ['vaga/cargo', 'vaga', 'cargo'],
  link: ['link da vaga', 'link'],
  appliedOn: ['data da candidatura'],
  status: ['status'],
  furthest: ['etapa mais avancada'],
  responseDate: ['data de retorno'],
  daysToResponse: ['dias ate retorno'],
  source: ['fonte'],
  contract: ['contratacao'],
  target: ['salario pretendido'],
  offered: ['salario oferecido'],
  notes: ['observacoes'],
} as const;

type ColumnKey = keyof typeof COLUMNS;

export function normalizeHeader(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseStatusName(value: string | undefined): Status | undefined {
  return value ? STATUS_BY_NAME[normalizeHeader(value)] : undefined;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
    if ('hyperlink' in value) return String(value.hyperlink ?? value.text ?? '').trim();
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text).trim();
    return '';
  }
  return String(value).trim();
}

/** Accepts real dates, ISO strings and dd/mm/yyyy. */
export function toIsoDate(value: ExcelJS.CellValue): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = cellText(value);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (br) return `${br[3]}-${br[2]!.padStart(2, '0')}-${br[1]!.padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function findHeaderRow(sheet: ExcelJS.Worksheet): { row: number; columns: Map<string, number> } | undefined {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber++) {
    const columns = new Map<string, number>();
    sheet.getRow(rowNumber).eachCell((cell, column) => {
      columns.set(normalizeHeader(cellText(cell.value)), column);
    });
    if (columns.has('empresa') && COLUMNS.link.some((name) => columns.has(name))) {
      return { row: rowNumber, columns };
    }
  }
  return undefined;
}

export function parseWorkbook(workbook: ExcelJS.Workbook): ParsedSheet {
  const found = workbook.worksheets
    .map((candidate) => ({ sheet: candidate, header: findHeaderRow(candidate) }))
    .find((candidate) => candidate.header);
  if (!found?.header) {
    throw new Error('No worksheet with an "Empresa" and a "Link da Vaga" column was found');
  }
  const { sheet, header: headerRow } = found;

  const columnIndex = (key: ColumnKey): number | undefined =>
    COLUMNS[key].map((name) => headerRow.columns.get(name)).find((index) => index !== undefined);
  const read = (row: ExcelJS.Row, key: ColumnKey): ExcelJS.CellValue => {
    const index = columnIndex(key);
    return index === undefined ? null : row.getCell(index).value;
  };

  const rows: ImportRow[] = [];
  const warnings: string[] = [];

  for (let rowNumber = headerRow.row + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const company = cellText(read(row, 'company'));
    const role = cellText(read(row, 'role'));
    if (!company && !role) continue; // blank row
    if (!company || !role) {
      warnings.push(`Row ${rowNumber}: company or role is empty; skipped`);
      continue;
    }

    const rawStatus = cellText(read(row, 'status'));
    let status = parseStatusName(rawStatus);
    if (!status) {
      if (rawStatus) warnings.push(`Row ${rowNumber}: unknown status "${rawStatus}"; imported as "applied"`);
      status = 'applied';
    }
    const furthest = parseStatusName(cellText(read(row, 'furthest')));
    const furthestStage = furthest && stageNumber(furthest) ? furthest : stageNumber(status) ? status : undefined;

    const rawLink = cellText(read(row, 'link'));
    const link = rawLink ? canonicalUrl(rawLink) : undefined;
    if (rawLink && !link) warnings.push(`Row ${rowNumber}: "${rawLink}" is not a valid URL; imported without a link`);

    const appliedOn = toIsoDate(read(row, 'appliedOn'));
    const responseDate = toIsoDate(read(row, 'responseDate'));
    const rawDays = cellText(read(row, 'daysToResponse'));
    const daysToResponse =
      rawDays !== '' && Number.isFinite(Number(rawDays))
        ? Number(rawDays)
        : appliedOn && responseDate
          ? daysBetween(appliedOn, responseDate)
          : undefined;

    const targetText = cellText(read(row, 'target'));
    const offeredText = cellText(read(row, 'offered'));
    const source = cellText(read(row, 'source'));

    rows.push({
      rowNumber,
      company,
      role,
      link,
      appliedOn,
      status,
      furthestStage,
      responseDate,
      daysToResponse,
      source: source ? slugify(source) : undefined,
      contracts: cellText(read(row, 'contract'))
        .split(/[,;/]| e /i)
        .map((value) => value.trim())
        .filter(Boolean),
      targetSalary: parseAmount(targetText),
      offeredSalary: parseAmount(offeredText),
      // Amounts in the spreadsheet are BRL unless the text says otherwise.
      currency: detectCurrency(offeredText) ?? detectCurrency(targetText) ?? (targetText || offeredText ? 'BRL' : undefined),
      notes: cellText(read(row, 'notes')) || undefined,
    });
  }
  return { rows, warnings };
}

export async function parseXlsx(path: string): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return parseWorkbook(workbook);
}
