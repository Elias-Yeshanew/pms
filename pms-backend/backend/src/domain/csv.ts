/** Minimal RFC 4180 CSV reader/writer: quoted fields, escaped quotes, commas and line breaks inside quotes, BOM, CRLF. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false, i = 0, touched = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; touched = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; touched = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (touched || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; touched = false; continue;
    }
    field += ch; touched = true; i++;
  }
  if (inQuotes) throw new Error('The CSV has an unclosed quote');
  if (touched || field !== '') { row.push(field); rows.push(row); }
  return rows;
}

const needsQuotes = /[",\r\n]/;
export const toCsv = (rows: string[][]): string => rows.map((r) => r.map((f) => (needsQuotes.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(',')).join('\r\n') + '\r\n';
