// Cadence-based schedule blocks. Pure date math shared by server and client.
// Always local-time (never toISOString) to avoid off-by-one timezone bugs.

import type { Cadence, LengthUnit } from './types.js';

export interface Block {
  index: number;
  startDate: string;
  endDate: string;
}

export const UNITS: LengthUnit[] = ['days', 'weeks', 'months', 'quarters', 'years'];
const DAYS_PER: Record<string, number> = { days: 1, weeks: 7 };
const MONTHS_PER: Record<string, number> = { months: 1, quarters: 3, years: 12 };

const pad = (n: number): string => String(n).padStart(2, '0');
const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string): Date => new Date(s + 'T00:00:00');

export function todayYmd(): string {
  return ymd(new Date());
}

export function addDaysLocal(dateStr: string, n: number): string {
  const d = parse(dateStr);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

// Add n calendar months, clamping the day to the target month's length
// (e.g. Jan 31 + 1 month -> Feb 28/29).
export function addMonthsLocal(dateStr: string, n: number): string {
  const d = parse(dateStr);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return ymd(d);
}

// Validates an untrusted cadence payload (request body / form state).
export function isValidCadence(c: any): c is Cadence {
  return !!c
    && /^\d{4}-\d{2}-\d{2}$/.test(c.anchorDate || '')
    && UNITS.includes(c.lengthUnit)
    && Number.isInteger(c.lengthValue) && c.lengthValue >= 1;
}

// First day of block i (i >= 0), counting from the anchor.
export function blockStart(cadence: Cadence, i: number): string {
  const { anchorDate, lengthUnit, lengthValue } = cadence;
  if (lengthUnit in DAYS_PER) {
    return addDaysLocal(anchorDate, i * lengthValue * DAYS_PER[lengthUnit]);
  }
  return addMonthsLocal(anchorDate, i * lengthValue * MONTHS_PER[lengthUnit]);
}

// Inclusive date range of block i: end = day before the next block starts.
export function blockRange(cadence: Cadence, i: number): Block {
  const startDate = blockStart(cadence, i);
  const endDate = addDaysLocal(blockStart(cadence, i + 1), -1);
  return { index: i, startDate, endDate };
}

// Smallest block index whose end is today or later — the "current" block
// (or block 0 if the anchor is in the future). Rolls past blocks off.
export function currentBlockIndex(cadence: Cadence, today: string): number {
  for (let i = 0; i < 100000; i++) {
    if (blockRange(cadence, i).endDate >= today) return i;
  }
  return 0;
}

// The current block plus the next (count-1) blocks.
export function upcomingBlocks(cadence: Cadence, today: string, count = 5): Block[] {
  const start = currentBlockIndex(cadence, today);
  const out: Block[] = [];
  for (let k = 0; k < count; k++) out.push(blockRange(cadence, start + k));
  return out;
}
