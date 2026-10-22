/** shared/image-metadata.ts — allow-list metadata stripping for JPEG / PNG / WebP. */
import { describe, it, expect } from 'vitest';
import { stripImageMetadata } from '../src/shared/image-metadata';
import {
  SECRET, JPEG_SCAN, PNG_IDAT, WEBP_VP8,
  jpegWithMetadata, pngWithMetadata, pngCriticalUnknown, webpWithMetadata,
} from './image-fixtures';

const has = (buf: Buffer, s: string) => buf.includes(Buffer.from(s, 'latin1'));

describe('stripImageMetadata', () => {
  it('JPEG: drops EXIF/XMP/ICC/IPTC/comments/trailer, keeps image segments and orientation', () => {
    const src = jpegWithMetadata(6);
    expect(has(src, SECRET)).toBe(true);
    const { data, mime, ext } = stripImageMetadata(src);
    expect([mime, ext]).toEqual(['image/jpeg', 'jpg']);
    expect(has(data, SECRET)).toBe(false);
    for (const tag of ['JFIF', 'http://ns.adobe.com', 'ICC_PROFILE', 'Photoshop', 'MotionPhoto']) expect(has(data, tag)).toBe(false);
    expect(data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(data.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(data.includes(JPEG_SCAN)).toBe(true); // scan data (incl. stuffed bytes + RST) untouched
    // Only a minimal EXIF block remains — Orientation 6, nothing else.
    const exif = data.indexOf(Buffer.from('Exif\0\0', 'latin1'));
    expect(exif).toBe(6); // right after SOI + APP1 header
    expect(data.readUInt16BE(4)).toBe(34);
    expect(data.readUInt16BE(exif + 6 + 18)).toBe(6);
    // Idempotent.
    expect(stripImageMetadata(data).data).toEqual(data);
  });

  it('JPEG: no EXIF block at all when the photo is upright', () => {
    const { data } = stripImageMetadata(jpegWithMetadata(1));
    expect(has(data, 'Exif')).toBe(false);
  });

  it('PNG: keeps IHDR/IDAT/IEND only, drops text/eXIf/tIME and bytes after IEND', () => {
    const { data, mime } = stripImageMetadata(pngWithMetadata());
    expect(mime).toBe('image/png');
    expect(has(data, SECRET)).toBe(false);
    for (const t of ['tEXt', 'iTXt', 'eXIf', 'tIME']) expect(has(data, t)).toBe(false);
    expect(data.includes(PNG_IDAT)).toBe(true);
    expect(data.subarray(-8, -4).toString('latin1')).toBe('IEND');
  });

  it('PNG: refuses an unknown critical chunk rather than passing it through', () => {
    expect(() => stripImageMetadata(pngCriticalUnknown())).toThrow(/couldn’t be read safely/);
  });

  it('WebP: drops ICCP/EXIF/XMP, clears the VP8X flags and fixes the RIFF size', () => {
    const { data, mime } = stripImageMetadata(webpWithMetadata());
    expect(mime).toBe('image/webp');
    expect(has(data, SECRET)).toBe(false);
    for (const t of ['ICCP', 'EXIF', 'XMP ']) expect(has(data, t)).toBe(false);
    expect(data.readUInt32LE(4)).toBe(data.length - 8);
    const vp8x = data.indexOf(Buffer.from('VP8X', 'latin1'));
    expect(data[vp8x + 8]).toBe(0);
    expect(data.includes(WEBP_VP8)).toBe(true);
  });

  it('rejects anything that is not a well-formed JPEG / PNG / WebP (status 400)', () => {
    const cases = [
      Buffer.from('%PDF-1.7 ' + SECRET),
      Buffer.from('GIF89a' + SECRET),
      Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),       // segment length past the end
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),                   // no frame header
      Buffer.alloc(0),
    ];
    for (const c of cases) {
      let err: (Error & { status?: number }) | null = null;
      try { stripImageMetadata(c); } catch (e) { err = e as Error & { status?: number }; }
      expect(err?.status).toBe(400);
    }
  });
});
