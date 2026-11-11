import { magvar } from 'magvar';

/**
 * Magnetic declination (degrees, east positive) at a place and date, from the World
 * Magnetic Model 2025. Orienteering maps are drawn to magnetic north, so this is the
 * angle by which the map must be turned clockwise to sit on a true-north base map.
 * Rounded to 0.1° — more precision than a printed map's own north lines.
 */
export function magneticDeclinationDeg(
  lon: number,
  lat: number,
  when: Date = new Date()
): number {
  try {
    return Math.round(magvar(lat, lon, 0, when) * 10) / 10;
  } catch {
    return 0;
  }
}
