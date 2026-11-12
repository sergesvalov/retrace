import { useCallback, useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { controlLabels } from '../../shared/course.js';
import { lonLatToPixel, pixelToLonLat } from '../../shared/georef.js';
import type { CourseControl } from '../../shared/types.js';

type Matrix = [number, number, number, number, number, number];

/** Overprint purple (ISOM course colour) */
export const COURSE_COLOR = '#c026d3';
const SOURCE_ID = 'course-lines';
const LAYER_ID = 'course-lines-layer';
const NO_CONTROLS: CourseControl[] = [];

interface Options {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
  mapReadyRef: React.MutableRefObject<boolean>;
  /** Increments on every MapLibre 'load' (the map is recreated per event) */
  mapLoadCount: number;
  controls: CourseControl[];
  /** Controls of the other courses on the area: drawn faded, unnumbered, not editable */
  otherControls?: CourseControl[];
  matrix: Matrix | undefined;
  visible: boolean;
  editable: boolean;
  onMove: (id: string, px: number, py: number) => void;
  onRemove: (id: string) => void;
}

/**
 * Draws the course (start triangle, numbered circles, finish, connecting lines) on the map.
 * Controls are stored in map-image pixels, so they follow the map placement.
 * Returns `syncToMatrix` to move the overprint live while the map itself is being dragged.
 */
export function useCourseOverlay({
  mapRef,
  mapReadyRef,
  mapLoadCount,
  controls,
  otherControls = NO_CONTROLS,
  matrix,
  visible,
  editable,
  onMove,
  onRemove,
}: Options): { syncToMatrix: (m: Matrix) => void } {
  const markersRef = useRef<{ control: CourseControl; marker: maplibregl.Marker }[]>([]);
  const otherMarkersRef = useRef<maplibregl.Marker[]>([]);
  const matrixRef = useRef(matrix);
  matrixRef.current = matrix;
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;

  useEffect(() => {
    const map = mapRef.current;
    // Not loaded yet: the 'load' handler bumps mapLoadCount and this effect runs again
    if (!map || !mapReadyRef.current) return;

    const draw = () => {
      for (const { marker } of markersRef.current) marker.remove();
      markersRef.current = [];
      for (const marker of otherMarkersRef.current) marker.remove();
      otherMarkersRef.current = [];
      if (visible && matrix) {
        // Other courses' controls: a click on one while editing adds it to this course
        for (const c of otherControls) {
          const el = makeControlElement('control', '', false);
          // On the inner drawing: MapLibre sets the marker element's own opacity itself
          el.dataset.otherCourse = '1';
          for (const child of Array.from(el.children)) {
            (child as HTMLElement | SVGElement).style.opacity = '0.4';
          }
          otherMarkersRef.current.push(
            new maplibregl.Marker({ element: el })
              .setLngLat(pixelToLonLat(matrix, c.px, c.py))
              .addTo(map)
          );
        }
      }

      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer(
          {
            id: LAYER_ID,
            type: 'line',
            source: SOURCE_ID,
            paint: {
              'line-color': COURSE_COLOR,
              'line-width': 2.5,
              'line-opacity': 0.85,
            },
          },
          // Under the runners' tails, above the map scan
          map.getLayer('ghost-tracks-casing') ? 'ghost-tracks-casing' : undefined
        );
      }

      const src = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource;
      if (!visible || !matrix || controls.length === 0) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
      }

      const ll = controls.map((c) => pixelToLonLat(matrix, c.px, c.py));
      src.setData(courseLineGeoJson(ll));

      const labels = controlLabels(controls);
      controls.forEach((control, i) => {
        const el = makeControlElement(control.kind, labels[i], editable);
        const marker = new maplibregl.Marker({ element: el, draggable: editable })
          .setLngLat(ll[i])
          .addTo(map);
        if (editable) {
          // Keep map clicks (which add controls) and the map-drag handler away from markers
          el.addEventListener('mousedown', (e) => e.stopPropagation());
          el.addEventListener('click', (e) => e.stopPropagation());
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemoveRef.current(control.id);
          });
          marker.on('drag', () => {
            // Move the connecting lines with the marker
            const live = markersRef.current.map(({ marker: m }) => {
              const p = m.getLngLat();
              return [p.lng, p.lat] as [number, number];
            });
            (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
              courseLineGeoJson(live)
            );
          });
          marker.on('dragend', () => {
            const m = matrixRef.current;
            if (!m) return;
            const p = marker.getLngLat();
            const px = lonLatToPixel(m, p.lng, p.lat);
            if (px) onMoveRef.current(control.id, px[0], px[1]);
          });
        }
        markersRef.current.push({ control, marker });
      });
    };

    draw();

    return () => {
      for (const { marker } of markersRef.current) marker.remove();
      markersRef.current = [];
      for (const marker of otherMarkersRef.current) marker.remove();
      otherMarkersRef.current = [];
    };
  }, [mapLoadCount, controls, otherControls, matrix, visible, editable]);

  const syncToMatrix = useCallback((m: Matrix) => {
    const map = mapRef.current;
    if (!map || markersRef.current.length === 0) return;
    const ll = markersRef.current.map(({ control, marker }) => {
      const p = pixelToLonLat(m, control.px, control.py);
      marker.setLngLat(p);
      return p;
    });
    (map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined)?.setData(
      courseLineGeoJson(ll)
    );
  }, []);

  return { syncToMatrix };
}

function courseLineGeoJson(ll: [number, number][]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features:
      ll.length >= 2
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: ll },
            },
          ]
        : [],
  };
}

function makeControlElement(
  kind: CourseControl['kind'],
  label: string,
  editable: boolean
): HTMLElement {
  const el = document.createElement('div');
  // No inline `position`: MapLibre's .maplibregl-marker is absolute (also the anchor for the
  // number label); an inline `relative` put the markers in flow, each one below the previous
  el.style.width = '28px';
  el.style.height = '28px';
  el.style.pointerEvents = editable ? 'auto' : 'none';
  el.style.cursor = editable ? 'grab' : 'default';
  if (editable) el.title = 'Перетащите, чтобы поправить. Правый клик — удалить';

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('width', '28');
  svg.setAttribute('height', '28');
  const stroke = (node: SVGElement) => {
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', COURSE_COLOR);
    node.setAttribute('stroke-width', '2.5');
    svg.appendChild(node);
  };
  if (kind === 'start') {
    const tri = document.createElementNS(ns, 'polygon');
    tri.setAttribute('points', '14,2 26,24 2,24');
    stroke(tri);
  } else {
    const outer = document.createElementNS(ns, 'circle');
    outer.setAttribute('cx', '14');
    outer.setAttribute('cy', '14');
    outer.setAttribute('r', '11.5');
    stroke(outer);
    if (kind === 'finish') {
      const inner = document.createElementNS(ns, 'circle');
      inner.setAttribute('cx', '14');
      inner.setAttribute('cy', '14');
      inner.setAttribute('r', '7');
      stroke(inner);
    }
  }
  el.appendChild(svg);

  if (kind === 'control') {
    const num = document.createElement('span');
    num.textContent = label;
    num.style.position = 'absolute';
    num.style.left = '27px';
    num.style.top = '-10px';
    num.style.font = '700 14px system-ui, sans-serif';
    num.style.color = COURSE_COLOR;
    num.style.textShadow = '0 0 3px #fff, 0 0 3px #fff, 0 0 2px #fff';
    num.style.whiteSpace = 'nowrap';
    el.appendChild(num);
  }
  return el;
}
