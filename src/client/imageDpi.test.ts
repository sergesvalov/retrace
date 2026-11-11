import { describe, expect, it } from 'vitest';
import { readImageDpi } from './imageDpi.js';

function jpegWithJfif(units: number, density: number): Uint8Array {
  // SOI, APP0 (len 16): "JFIF\0", v1.01, units, Xdensity, Ydensity, 0x0 thumbnail; then SOS
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01,
    units,
    density >> 8, density & 0xff,
    density >> 8, density & 0xff,
    0x00, 0x00,
    0xff, 0xda, 0x00, 0x02,
  ]);
}

function jpegWithExif(dpi: number): Uint8Array {
  // APP1 "Exif\0\0" + little-endian TIFF with IFD0: XResolution (rational) + ResolutionUnit=2
  const tiff = [
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // header, IFD0 at 8
    0x02, 0x00, // 2 entries
    0x1a, 0x01, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, // XResolution -> 38
    0x28, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, // unit = inch
    0x00, 0x00, 0x00, 0x00, // next IFD
    dpi & 0xff, dpi >> 8, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // dpi / 1
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, len >> 8, len & 0xff, ...payload,
    0xff, 0xda, 0x00, 0x02,
  ]);
}

function pngWithPhys(pixelsPerMetre: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const ihdr = [...u32(13), 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0];
  const phys = [
    ...u32(9), 0x70, 0x48, 0x59, 0x73,
    ...u32(pixelsPerMetre), ...u32(pixelsPerMetre), 1,
    0, 0, 0, 0,
  ];
  return new Uint8Array([...sig, ...ihdr, ...phys]);
}

// Copy into a plain ArrayBuffer-backed view: BlobPart does not accept ArrayBufferLike
const file = (bytes: Uint8Array) => new File([new Uint8Array(bytes)], 'scan');

describe('readImageDpi', () => {
  it('reads JFIF dots per inch and per centimetre', async () => {
    expect(await readImageDpi(file(jpegWithJfif(1, 300)))).toBe(300);
    expect(await readImageDpi(file(jpegWithJfif(2, 118)))).toBe(300); // 118 dpcm ≈ 300 dpi
  });

  it('reads EXIF XResolution', async () => {
    expect(await readImageDpi(file(jpegWithExif(600)))).toBe(600);
  });

  it('reads PNG pHYs', async () => {
    expect(await readImageDpi(file(pngWithPhys(11811)))).toBe(300);
  });

  it('ignores screen defaults and missing data', async () => {
    expect(await readImageDpi(file(jpegWithJfif(1, 72)))).toBeNull();
    expect(await readImageDpi(file(jpegWithJfif(0, 1)))).toBeNull();
    expect(await readImageDpi(file(new Uint8Array([1, 2, 3])))).toBeNull();
  });
});
