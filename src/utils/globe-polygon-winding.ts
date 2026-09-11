import { geoArea } from 'd3-geo';

/** Normalize bounded country/regional polygons for d3's spherical convention.
 * Exterior rings enclose the smaller spherical area; holes use the opposite
 * winding. Do not mutate shared GeoJSON used by the flat renderer.
 */
export function normalizeGlobePolygonRings(rings: number[][][]): number[][][] {
  return rings.map((ring, index) => {
    const area = geoArea({ type: 'Polygon', coordinates: [ring] });
    const enclosesSmallArea = area <= 2 * Math.PI;
    const shouldReverse = index === 0 ? !enclosesSmallArea : enclosesSmallArea;
    return (shouldReverse ? [...ring].reverse() : ring).map((point) => [...point]);
  });
}
