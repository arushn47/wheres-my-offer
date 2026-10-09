import { createClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
export interface FixtureRequest { table: string; select: string; rows: number; bytes: number; params: URLSearchParams }
function split(value: string): string[] {
  const parts: string[] = []; let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && quoted) { i++; continue; }
    if (value[i] === '"') quoted = !quoted;
    if (!quoted) {
      if (value[i] === '(') depth++;
      if (value[i] === ')') depth--;
      if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
    }
  }
  return [...parts, value.slice(start)];
}
const unquote = (value: string) => value.startsWith('"') ? JSON.parse(value) as string : value;
function condition(row: Row, expression: string): boolean {
  const match = expression.match(/^([^.]+)\.([^.]+)\.(.*)$/);
  if (!match) throw new Error(`Unsupported fixture filter ${expression}`);
  const [, field, op, raw] = match; const value = row[field];
  if (op === 'not' && raw === 'is.null') return value !== null && value !== undefined;
  if (op === 'eq') return value === unquote(raw);
  if (op === 'in') return typeof value === 'string' && split(raw.slice(1, -1)).map(unquote).includes(value);
  if (op === 'ilike') {
    const pattern = unquote(raw).split(/([*%_])/).map(part => part === '*' || part === '%' ? '.*' : part === '_' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return typeof value === 'string' && new RegExp(`^${pattern}$`, 'i').test(value);
  }
  throw new Error(`Unsupported fixture operator ${op}`);
}

/** Uses the real Supabase/PostgREST serializer, with fixture-only HTTP responses. */
export function postgrestFixture(tables: Record<string, Row[]>) {
  const requests: FixtureRequest[] = [];
  const admin = createClient('https://fixture.invalid', 'fixture-key', { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const table = url.pathname.split('/').at(-1)!; const select = url.searchParams.get('select')!;
      let rows = [...(tables[table] || [])];
      for (const [key, value] of url.searchParams) {
        if (key === 'or') rows = rows.filter(row => split(value.slice(1, -1)).some(part => condition(row, part)));
        else if (!['select', 'order', 'offset', 'limit'].includes(key)) rows = rows.filter(row => condition(row, `${key}.${value}`));
      }
      const order = (url.searchParams.get('order') || '').split(',').filter(Boolean).map(part => part.split('.'));
      rows.sort((a, b) => {
        for (const [field, direction] of order) {
          const delta = String(a[field] || '').localeCompare(String(b[field] || ''));
          if (delta) return direction === 'desc' ? -delta : delta;
        }
        return 0;
      });
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || rows.length);
      rows = rows.slice(offset, offset + limit).map(row => Object.fromEntries(select.split(',').map(field => field.trim()).map(field => [field, row[field] ?? null])));
      const body = JSON.stringify(rows);
      requests.push({ table, select, rows: rows.length, bytes: Buffer.byteLength(body), params: url.searchParams });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    },
  } });
  return { admin, requests };
}
