/** Strip identifying metadata from an uploaded photo, without decoding or re-encoding pixels
 *  (no image library needed). Used by the anonymous reporting channel, where a photo's hidden
 *  details — camera/phone model, GPS position, capture time, editing software, embedded
 *  thumbnails, comments — could identify the reporter.
 *
 *  Allow-list, fail closed: the container is walked structurally and ONLY the segments/chunks
 *  needed to show the picture are copied; everything else (EXIF, XMP, IPTC, ICC profiles,
 *  comments, text chunks, maker notes, anything after the end-of-image marker such as
 *  multi-picture previews or motion-photo video) is dropped. A file that isn't a well-formed
 *  JPEG / PNG / WebP is rejected rather than passed through. The type is decided from the
 *  bytes, never from the client's filename or Content-Type.
 *
 *  The one fact carried over is a JPEG's EXIF orientation (1–8), re-emitted as a fresh
 *  minimal EXIF block, so a phone photo isn't shown sideways. It says nothing about who took it.
 *
 *  Not covered (by design, and said so in the UI): what the picture itself shows — faces,
 *  name tags, screens, reflections, a recognisable spot. */

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';
export interface ScrubbedImage { data: Buffer; mime: ImageMime; ext: 'jpg' | 'png' | 'webp' }

function bad(msg = 'This photo couldn’t be read safely. Try taking it again, or attach a JPEG or PNG.'): never {
  throw Object.assign(new Error(msg), { status: 400 });
}

export function stripImageMetadata(input: Buffer): ScrubbedImage {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    return { data: stripJpeg(input), mime: 'image/jpeg', ext: 'jpg' };
  }
  if (input.length >= 8 && input.subarray(0, 8).equals(PNG_SIG)) {
    return { data: stripPng(input), mime: 'image/png', ext: 'png' };
  }
  if (input.length >= 12 && input.toString('latin1', 0, 4) === 'RIFF' && input.toString('latin1', 8, 12) === 'WEBP') {
    return { data: stripWebp(input), mime: 'image/webp', ext: 'webp' };
  }
  return bad('Only photos can be attached (JPEG, PNG or WebP).');
}

// ─── JPEG ────────────────────────────────────────────────────────────────────

/** Segments that describe the image itself: SOF0–15 (incl. DHT C4 / DAC CC), DNL, DQT, DRI. */
const keepJpegMarker = (m: number) => (m >= 0xc0 && m <= 0xcf) || m === 0xdb || m === 0xdc || m === 0xdd;

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [];
  let orientation: number | null = null;
  let sawFrame = false;
  let i = 2; // past SOI
  while (i < b.length) {
    if (b[i] !== 0xff) bad();
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) bad();
    const marker = b[i]!;
    i++;
    if (marker === 0xd9) return finishJpeg(out, orientation, sawFrame); // EOI — anything after it is dropped
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(Buffer.from([0xff, marker])); continue; }
    if (marker === 0xd8 || marker === 0x00) bad();
    if (i + 2 > b.length) bad();
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) bad();
    const seg = b.subarray(i - 2, i + len);
    const payload = b.subarray(i + 2, i + len);
    i += len;

    if (marker === 0xe1 && orientation === null) orientation = exifOrientation(payload);
    // APP0–APP15: JFIF/EXIF/XMP/ICC/IPTC/maker data. Only a bare Adobe APP14 (colour transform
    // flag, needed to decode some CMYK/RGB files) survives — it's 12 fixed bytes, no free text.
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker === 0xee && payload.length === 12 && payload.toString('latin1', 0, 5) === 'Adobe') out.push(seg);
      continue;
    }
    if (marker === 0xfe) continue; // COM (comment)
    if (marker === 0xda) {
      if (!sawFrame) bad();
      out.push(seg);
      // Entropy-coded scan data runs to the next marker that isn't a stuffed 0x00, a restart
      // marker or a fill byte.
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const n = b[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { i += 2; continue; }
          if (n === 0xff) { i += 1; continue; }
          break;
        }
        i++;
      }
      out.push(b.subarray(start, i));
      if (i >= b.length) return finishJpeg(out, orientation, sawFrame); // truncated before EOI — close it
      continue;
    }
    if (keepJpegMarker(marker)) {
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
      out.push(seg);
    }
    // Anything else (JPG extensions, reserved markers) is dropped.
  }
  return bad();
}

function finishJpeg(parts: Buffer[], orientation: number | null, sawFrame: boolean): Buffer {
  if (!sawFrame) bad();
  const head: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation && orientation !== 1) head.push(orientationExif(orientation));
  return Buffer.concat([...head, ...parts, Buffer.from([0xff, 0xd9])]);
}

/** Read the Orientation tag (0x0112) from IFD0 of an APP1 "Exif" payload, or null. */
function exifOrientation(p: Buffer): number | null {
  if (p.length < 14 || p.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const t = p.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return null;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A minimal APP1 EXIF block holding only IFD0 → Orientation. */
function orientationExif(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);          // IFD0 offset
  tiff.writeUInt16BE(1, 8);          // one entry
  tiff.writeUInt16BE(0x0112, 10);    // Orientation
  tiff.writeUInt16BE(3, 12);         // SHORT
  tiff.writeUInt32BE(1, 14);         // count
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);         // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks needed to render the image correctly. Text (tEXt/zTXt/iTXt), eXIf, tIME, iCCP, pHYs,
 *  animation and every unknown ancillary chunk are dropped. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD']);

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  let first = true;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || len > 0x7fffffff || i + 12 + len > b.length) bad();
    if (first && type !== 'IHDR') bad();
    first = false;
    const chunk = b.subarray(i, i + 12 + len);
    i += 12 + len;
    if (PNG_KEEP.has(type)) out.push(chunk);
    // An unknown CRITICAL chunk (uppercase first letter) means we can't render it safely.
    else if (type[0]! >= 'A' && type[0]! <= 'Z') bad();
    if (type === 'IEND') return Buffer.concat(out); // anything after IEND is dropped
  }
  return bad();
}

// ─── WebP ────────────────────────────────────────────────────────────────────

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

function stripWebp(b: Buffer): Buffer {
  const riffEnd = Math.min(b.length, 8 + b.readUInt32LE(4)); // bytes past the RIFF size are dropped
  const chunks: Buffer[] = [];
  let hasImage = false;
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const padded = len + (len & 1);
    if (i + 8 + len > riffEnd) bad();
    if (WEBP_KEEP.has(type)) {
      // Copy with its pad byte (zero-filled if an odd-length final chunk omitted it).
      const full = Buffer.alloc(8 + padded);
      b.copy(full, 0, i, Math.min(i + 8 + padded, riffEnd));
      // VP8X flags: clear ICC (0x20), EXIF (0x08) and XMP (0x04) — those chunks are gone.
      if (type === 'VP8X' && len >= 1) full[8] = full[8]! & ~(0x20 | 0x08 | 0x04);
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') hasImage = true;
      chunks.push(full);
    }
    i += 8 + padded;
  }
  if (!hasImage) bad();
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
