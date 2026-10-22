/** Synthetic JPEG / PNG / WebP files carrying identifying metadata in every place a phone or
 *  editor puts it. Structurally valid containers (what the metadata stripper walks); the pixel
 *  data is filler. Every metadata block contains SECRET so a test can grep the output for it. */
export const SECRET = 'SecretPhone-GPS-14.5995N-Juan';

const jpegSeg = (marker: number, payload: Buffer) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};

/** EXIF APP1 payload: IFD0 with Orientation (+ a Make string holding SECRET). */
function exifPayload(orientation: number): Buffer {
  const make = Buffer.from(SECRET + '\0', 'latin1');
  const t = Buffer.alloc(8 + 2 + 2 * 12 + 4);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  t.writeUInt16LE(2, 8);
  // 0x010F Make, ASCII, points past the IFD
  t.writeUInt16LE(0x010f, 10); t.writeUInt16LE(2, 12); t.writeUInt32LE(make.length, 14); t.writeUInt32LE(t.length, 18);
  // 0x0112 Orientation, SHORT
  t.writeUInt16LE(0x0112, 22); t.writeUInt16LE(3, 24); t.writeUInt32LE(1, 26); t.writeUInt16LE(orientation, 30);
  t.writeUInt32LE(0, 34);
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, make]);
}

/** Entropy-coded filler that includes a stuffed 0xFF00 and a restart marker. */
export const JPEG_SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd3, 0x78, 0x9a]);

export function jpegWithMetadata(orientation = 6): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSeg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    jpegSeg(0xe1, exifPayload(orientation)),
    jpegSeg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>' + SECRET + '</x:xmpmeta>', 'latin1')),
    jpegSeg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01' + SECRET, 'latin1')),
    jpegSeg(0xed, Buffer.from('Photoshop 3.0\0' + SECRET, 'latin1')),
    jpegSeg(0xfe, Buffer.from('taken by ' + SECRET, 'latin1')),
    jpegSeg(0xdb, Buffer.alloc(65, 1)),                                         // DQT
    jpegSeg(0xc0, Buffer.from([8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])), // SOF0 16x16
    jpegSeg(0xc4, Buffer.alloc(29, 0)),                                         // DHT
    jpegSeg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),        // SOS
    JPEG_SCAN,
    Buffer.from([0xff, 0xd9]),
    Buffer.from('MotionPhoto_Data ' + SECRET, 'latin1'),                         // trailer after EOI
  ]);
}

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC not checked
};
export const PNG_IDAT = Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00]);

export function pngWithMetadata(extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Author\0' + SECRET, 'latin1')),
    pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0' + SECRET, 'latin1')),
    pngChunk('eXIf', exifPayload(1).subarray(6)),
    pngChunk('tIME', Buffer.from([7, 234, 9, 28, 14, 30, 12])),
    ...extra,
    pngChunk('IDAT', PNG_IDAT),
    pngChunk('IEND', Buffer.alloc(0)),
    Buffer.from(SECRET, 'latin1'),
  ]);
}
export const pngCriticalUnknown = () => pngWithMetadata([pngChunk('ABCD', Buffer.alloc(2))]);

const riffChunk = (type: string, data: Buffer) => {
  const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
export const WEBP_VP8 = Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01]); // odd length → padded

export function webpWithMetadata(): Buffer {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x2c; // ICC + EXIF + XMP flags
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8X', vp8x),
    riffChunk('ICCP', Buffer.from(SECRET, 'latin1')),
    riffChunk('VP8 ', WEBP_VP8),
    riffChunk('EXIF', exifPayload(1).subarray(6)),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta>' + SECRET, 'latin1')),
  ]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.from(SECRET, 'latin1')]);
}
