/** Client-side CSV export of ledger-derived tables. Values are passed as strings (base-unit integers stay strings: BigInt-safe, never through Number). */
const esc = (v: string) => { const s = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? "'" + v : v; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (header: string[], rows: string[][]) => [header, ...rows].map((r) => r.map((c) => esc(String(c ?? ''))).join(',')).join('\r\n') + '\r\n';
export function downloadCsv(filename: string, header: string[], rows: string[][]) {
  const blob = new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
