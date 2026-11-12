import { describe, expect, it } from 'vitest';
import { cookiePath, trustProxyFromEnv } from './proxy.js';

describe('trustProxyFromEnv', () => {
  it('no proxy unless set', () => {
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv('')).toBe(false);
    expect(trustProxyFromEnv('0')).toBe(false);
  });

  it('1 trusts every hop, anything else is the list of proxy addresses', () => {
    expect(trustProxyFromEnv('1')).toBe(true);
    expect(trustProxyFromEnv(' 192.168.0.230 ')).toBe('192.168.0.230');
    expect(trustProxyFromEnv('192.168.0.230,10.0.0.0/8')).toBe('192.168.0.230,10.0.0.0/8');
  });
});

describe('cookiePath', () => {
  it('the site root at home', () => {
    expect(cookiePath(undefined)).toBe('/');
  });

  it('the prefix behind haproxy', () => {
    expect(cookiePath('/retrace')).toBe('/retrace/');
    expect(cookiePath('/apps/retrace')).toBe('/apps/retrace/');
  });

  it('ignores anything that is not a plain path', () => {
    expect(cookiePath('/retrace/')).toBe('/');
    expect(cookiePath('/retrace; Domain=evil')).toBe('/');
    expect(cookiePath('retrace')).toBe('/');
    expect(cookiePath(['/a', '/b'])).toBe('/');
  });
});
