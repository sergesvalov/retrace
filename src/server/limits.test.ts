import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { hasFreeSpace, imageExtOf, PAGE_CSP } from './limits.js';

describe('imageExtOf', () => {
  const bytes = (...b: (number | string)[]) =>
    Uint8Array.from(b.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));

  it('knows the image by its first bytes', () => {
    expect(imageExtOf(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('.png');
    expect(imageExtOf(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('.jpg');
    expect(imageExtOf(bytes('GIF89a'))).toBe('.gif');
    expect(imageExtOf(bytes('RIFF', 0, 0, 0, 0, 'WEBPVP8 '))).toBe('.webp');
  });

  it('anything else is not an image, whatever its name', () => {
    expect(imageExtOf(bytes('<html><script>alert(1)</script>'))).toBeNull();
    expect(imageExtOf(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageExtOf(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBeNull();
    expect(imageExtOf(new Uint8Array())).toBeNull();
  });
});

describe('hasFreeSpace', () => {
  it('compares the free space of the disk with the minimum', async () => {
    expect(await hasFreeSpace(os.tmpdir(), 1)).toBe(true);
    expect(await hasFreeSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

describe('PAGE_CSP', () => {
  it('scripts only from the site, no framing', () => {
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });
});
