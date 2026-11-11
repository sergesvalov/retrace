/**
 * Read the scan resolution a scanner stores in the image header, so the user only has to
 * type the print scale (it is printed on every O-map). Supports JPEG (JFIF density and
 * EXIF XResolution) and PNG (pHYs). Returns null when absent or a screen default
 * (72/96 dpi), which says nothing about a scan.
 */
export async function readImageDpi(file: File): Promise<number | null> {
  try {
    const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    const dpi = isPng(buf) ? pngDpi(buf) : isJpeg(buf) ? jpegDpi(buf) : null;
    if (dpi === null || !Number.isFinite(dpi)) return null;
    const rounded = Math.round(dpi);
    return rounded >= 100 && rounded <= 2400 ? rounded : null;
  } catch {
    return null;
  }
}

function isPng(v: DataView): boolean {
  return v.byteLength > 8 && v.getUint32(0) === 0x89504e47;
}

function isJpeg(v: DataView): boolean {
  return v.byteLength > 4 && v.getUint16(0) === 0xffd8;
}

function pngDpi(v: DataView): number | null {
  let off = 8;
  while (off + 12 <= v.byteLength) {
    const len = v.getUint32(off);
    const type = v.getUint32(off + 4);
    if (type === 0x70485973 /* pHYs */ && len >= 9) {
      const ppuX = v.getUint32(off + 8);
      const unit = v.getUint8(off + 16);
      return unit === 1 ? ppuX * 0.0254 : null; // pixels per metre
    }
    if (type === 0x49444154 /* IDAT */ || type === 0x49454e44 /* IEND */) break;
    off += 12 + len;
  }
  return null;
}

function jpegDpi(v: DataView): number | null {
  let off = 2;
  let jfif: number | null = null;
  while (off + 4 <= v.byteLength) {
    if (v.getUint8(off) !== 0xff) break;
    const marker = v.getUint8(off + 1);
    const len = v.getUint16(off + 2);
    const seg = off + 4;
    if (marker === 0xe1 && isAscii(v, seg, 'Exif')) {
      const exif = exifDpi(v, seg + 6);
      if (exif !== null) return exif; // EXIF is what scanners fill in most reliably
    } else if (marker === 0xe0 && isAscii(v, seg, 'JFIF')) {
      const units = v.getUint8(seg + 7);
      const xDensity = v.getUint16(seg + 8);
      if (units === 1) jfif = xDensity;
      else if (units === 2) jfif = xDensity * 2.54;
    }
    if (marker === 0xda) break; // start of scan: no more headers
    off += 2 + len;
  }
  return jfif;
}

function exifDpi(v: DataView, tiff: number): number | null {
  if (tiff + 8 > v.byteLength) return null;
  const little = v.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => v.getUint16(o, little);
  const u32 = (o: number) => v.getUint32(o, little);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > v.byteLength) return null;
  const count = u16(ifd);
  let xRes: number | null = null;
  let unit = 2; // default: inches
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > v.byteLength) break;
    const tag = u16(entry);
    if (tag === 0x011a) {
      const valOff = tiff + u32(entry + 8);
      if (valOff + 8 <= v.byteLength) {
        const den = u32(valOff + 4);
        xRes = den ? u32(valOff) / den : null;
      }
    } else if (tag === 0x0128) {
      unit = u16(entry + 8);
    }
  }
  if (xRes === null) return null;
  if (unit === 3) return xRes * 2.54; // per centimetre
  return unit === 2 ? xRes : null;
}

function isAscii(v: DataView, off: number, text: string): boolean {
  if (off + text.length > v.byteLength) return false;
  for (let i = 0; i < text.length; i++) {
    if (v.getUint8(off + i) !== text.charCodeAt(i)) return false;
  }
  return true;
}
