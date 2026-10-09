// Reads the CSV files that ml/export/ writes: a header row, commas, and double quotes around any
// field that holds a comma, a quote or a line break (a quote inside is doubled).

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => !(r.length === 1 && r[0] === ""))
    .map((r, n) => {
      if (r.length !== header.length) throw new Error(`Row ${n + 2} has ${r.length} fields, the header has ${header.length}`);
      return Object.fromEntries(header.map((name, i) => [name, r[i]]));
    });
}
