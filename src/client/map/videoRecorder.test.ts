import { describe, expect, it } from 'vitest';
import { videoFileName } from './videoRecorder.js';

describe('videoFileName', () => {
  it('joins the event and the run, keeps Cyrillic, drops characters files cannot have', () => {
    expect(videoFileName(['Кросс: осень', 'Перегон КП 1 → КП 2'], 'mp4')).toBe(
      'Кросс_осень_-_Перегон_КП_1_→_КП_2.mp4'
    );
  });

  it('falls back to a generic name', () => {
    expect(videoFileName(['  ', ''], 'webm')).toBe('replay.webm');
  });
});
