// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { extractFileText } from './source-extraction';

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({
  default: import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'),
}));

function pdfFile(text: string | null, options: { encrypted?: boolean; pageCount?: number } = {}): File {
  const content = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const pageCount = options.pageCount ?? 1;
  const kids = ['3 0 R', ...Array.from({ length: pageCount - 1 }, (_, index) => `${index + 6} 0 R`)].join(' ');
  const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    page,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  for (let index = 1; index < pageCount; index++) objects.push(page);
  if (options.encrypted) {
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const encryption = options.encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${'00'.repeat(16)}> <${'00'.repeat(16)}>]` : '';
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([pdf], 'example.pdf', { type: 'application/pdf' });
}

describe('PDF extraction with PDF.js', () => {
  it('extracts selectable PDF text', async () => {
    await expect(extractFileText(pdfFile('Hello PDF'))).resolves.toBe('Hello PDF');
  });

  it('reports PDFs without selectable text and malformed files', async () => {
    await expect(extractFileText(pdfFile(null))).rejects.toMatchObject({ code: 'no-text' });
    await expect(extractFileText(new File(['not a PDF'], 'bad.pdf'))).rejects.toMatchObject({ code: 'invalid-pdf' });
  });

  it('rejects encrypted and oversized-page-count PDFs', async () => {
    await expect(extractFileText(pdfFile(null, { encrypted: true }))).rejects.toMatchObject({ code: 'encrypted-pdf' });
    await expect(extractFileText(pdfFile(null, { pageCount: 201 }))).rejects.toMatchObject({ code: 'too-large' });
  });
});
