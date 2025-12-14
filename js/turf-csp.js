// Minimal CSP-compatible Turf.js subset
// Contains only the functions needed for brunnel detection
// Avoids eval() and new Function() for Content Security Policy compliance

(function(global) {
  'use strict';

  const EARTH_RADIUS = 6371008.8; // meters

  // ============================================================================
  // Helper Functions
  // ============================================================================

  function degreesToRadians(degrees) {
    return degrees * Math.PI / 180;
  }

  function radiansToDegrees(radians) {
    return radians * 180 / Math.PI;
  }

  function lengthToRadians(distance, units = 'kilometers') {
    const factors = {
      meters: EARTH_RADIUS,
      kilometres: 6371.0088,
      kilometers: 6371.0088,
      miles: 3958.761333810546
    };
    const factor = factors[units];
    if (!factor) throw new Error(`Invalid units: ${units}`);
    return distance / factor;
  }

  function radiansToLength(radians, units = 'kilometers') {
    const factors = {
      meters: EARTH_RADIUS,
      kilometres: 6371.0088,
      kilometers: 6371.0088,
      miles: 3958.761333810546
    };
    const factor = factors[units];
    if (!factor) throw new Error(`Invalid units: ${units}`);
    return radians * factor;
  }

  // ============================================================================
  // GeoJSON Constructors
  // ============================================================================

  function point(coordinates, properties, options) {
    return {
      type: 'Feature',
      properties: properties || {},
      geometry: {
        type: 'Point',
        coordinates: coordinates
      }
    };
  }

  function lineString(coordinates, properties, options) {
    if (coordinates.length < 2) {
      throw new Error('coordinates must be an array of two or more positions');
    }
    return {
      type: 'Feature',
      properties: properties || {},
      geometry: {
        type: 'LineString',
        coordinates: coordinates
      }
    };
  }

  function polygon(coordinates, properties, options) {
    return {
      type: 'Feature',
      properties: properties || {},
      geometry: {
        type: 'Polygon',
        coordinates: coordinates
      }
    };
  }

  function featureCollection(features) {
    return {
      type: 'FeatureCollection',
      features: features
    };
  }

  // ============================================================================
  // Measurement Functions
  // ============================================================================

  function bbox(geojson) {
    const result = [Infinity, Infinity, -Infinity, -Infinity];
    coordEach(geojson, (coord) => {
      if (result[0] > coord[0]) result[0] = coord[0];
      if (result[1] > coord[1]) result[1] = coord[1];
      if (result[2] < coord[0]) result[2] = coord[0];
      if (result[3] < coord[1]) result[3] = coord[1];
    });
    return result;
  }

  function coordEach(geojson, callback) {
    let coords;
    const type = geojson.type;
    const isFeature = type === 'Feature';
    const isFeatureCollection = type === 'FeatureCollection';

    if (isFeatureCollection) {
      for (const feature of geojson.features) {
        coordEach(feature, callback);
      }
      return;
    }

    const geometry = isFeature ? geojson.geometry : geojson;
    if (!geometry) return;

    coords = geometry.coordinates;
    const geomType = geometry.type;

    switch (geomType) {
      case 'Point':
        callback(coords);
        break;
      case 'LineString':
      case 'MultiPoint':
        for (const coord of coords) callback(coord);
        break;
      case 'Polygon':
      case 'MultiLineString':
        for (const ring of coords) {
          for (const coord of ring) callback(coord);
        }
        break;
      case 'MultiPolygon':
        for (const poly of coords) {
          for (const ring of poly) {
            for (const coord of ring) callback(coord);
          }
        }
        break;
    }
  }

  function distance(from, to, options = {}) {
    const units = options.units || 'kilometers';
    const coords1 = getCoord(from);
    const coords2 = getCoord(to);
    const dLat = degreesToRadians(coords2[1] - coords1[1]);
    const dLon = degreesToRadians(coords2[0] - coords1[0]);
    const lat1 = degreesToRadians(coords1[1]);
    const lat2 = degreesToRadians(coords2[1]);

    const a = Math.pow(Math.sin(dLat / 2), 2) +
              Math.pow(Math.sin(dLon / 2), 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return radiansToLength(c, units);
  }

  function getCoord(coord) {
    if (Array.isArray(coord)) return coord;
    if (coord.type === 'Feature' && coord.geometry && coord.geometry.type === 'Point') {
      return coord.geometry.coordinates;
    }
    if (coord.type === 'Point') return coord.coordinates;
    throw new Error('Invalid coordinate');
  }

  function getCoords(geojson) {
    if (Array.isArray(geojson)) return geojson;
    if (geojson.type === 'Feature') return geojson.geometry.coordinates;
    return geojson.coordinates;
  }

  // ============================================================================
  // Bearing Functions
  // ============================================================================

  function rhumbBearing(start, end, options = {}) {
    const from = getCoord(start);
    const to = getCoord(end);
    const phi1 = degreesToRadians(from[1]);
    const phi2 = degreesToRadians(to[1]);
    let deltaLambda = degreesToRadians(to[0] - from[0]);

    // if deltaLambda over 180° take shorter rhumb line across the anti-meridian
    if (deltaLambda > Math.PI) deltaLambda -= 2 * Math.PI;
    if (deltaLambda < -Math.PI) deltaLambda += 2 * Math.PI;

    const deltaPsi = Math.log(
      Math.tan(phi2 / 2 + Math.PI / 4) / Math.tan(phi1 / 2 + Math.PI / 4)
    );

    const theta = Math.atan2(deltaLambda, deltaPsi);
    const bearing = radiansToDegrees(theta);

    return options.final ? (bearing + 180) % 360 : (bearing + 360) % 360;
  }

  function rhumbDestination(origin, distance, bearing, options = {}) {
    const units = options.units || 'kilometers';
    const coords = getCoord(origin);
    const delta = lengthToRadians(distance, units);
    const lambda1 = degreesToRadians(coords[0]);
    const phi1 = degreesToRadians(coords[1]);
    const theta = degreesToRadians(bearing);

    const deltaPhi = delta * Math.cos(theta);
    let phi2 = phi1 + deltaPhi;

    // check for some daft bugger going past the pole, normalise latitude if so
    if (Math.abs(phi2) > Math.PI / 2) {
      phi2 = phi2 > 0 ? Math.PI - phi2 : -Math.PI - phi2;
    }

    const deltaPsi = Math.log(
      Math.tan(phi2 / 2 + Math.PI / 4) / Math.tan(phi1 / 2 + Math.PI / 4)
    );
    const q = Math.abs(deltaPsi) > 1e-12 ? deltaPhi / deltaPsi : Math.cos(phi1);
    const deltaLambda = (delta * Math.sin(theta)) / q;
    const lambda2 = lambda1 + deltaLambda;

    return point([
      radiansToDegrees(lambda2),
      radiansToDegrees(phi2)
    ], options.properties);
  }

  // ============================================================================
  // Boolean Functions
  // ============================================================================

  function booleanPointInPolygon(pt, poly, options = {}) {
    const coord = getCoord(pt);
    const geom = poly.type === 'Feature' ? poly.geometry : poly;
    const type = geom.type;
    const bbox = poly.bbox;
    let polys = geom.coordinates;

    // Quick bbox check
    if (bbox && !inBBox(coord, bbox)) return false;

    // normalize to multipolygon
    if (type === 'Polygon') polys = [polys];

    let result = false;
    for (let i = 0; i < polys.length && !result; i++) {
      // check if in outer ring
      if (inRing(coord, polys[i][0])) {
        let inHole = false;
        // check for holes
        for (let k = 1; k < polys[i].length && !inHole; k++) {
          if (inRing(coord, polys[i][k])) inHole = true;
        }
        if (!inHole) result = true;
      }
    }
    return result;
  }

  function inBBox(pt, bbox) {
    return bbox[0] <= pt[0] && bbox[1] <= pt[1] && bbox[2] >= pt[0] && bbox[3] >= pt[1];
  }

  function inRing(pt, ring) {
    let isInside = false;
    const x = pt[0];
    const y = pt[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) isInside = !isInside;
    }
    return isInside;
  }

  // ============================================================================
  // Transformation Functions
  // ============================================================================

  function polygonToLine(poly, options = {}) {
    const geom = poly.type === 'Feature' ? poly.geometry : poly;
    const coords = geom.coordinates;
    const properties = options.properties || (poly.type === 'Feature' ? poly.properties : {});

    if (geom.type === 'Polygon') {
      return lineString(coords[0], properties);
    } else if (geom.type === 'MultiPolygon') {
      const lines = [];
      for (const ring of coords) {
        lines.push(lineString(ring[0], properties));
      }
      return featureCollection(lines);
    }
    throw new Error('Invalid input type');
  }

  // ============================================================================
  // Line Functions
  // ============================================================================

  function lineIntersect(line1, line2) {
    const features = [];
    const coords1 = getLineCoords(line1);
    const coords2 = getLineCoords(line2);

    for (let i = 0; i < coords1.length - 1; i++) {
      for (let j = 0; j < coords2.length - 1; j++) {
        const intersect = segmentIntersect(
          coords1[i], coords1[i + 1],
          coords2[j], coords2[j + 1]
        );
        if (intersect) {
          features.push(point(intersect));
        }
      }
    }
    return featureCollection(features);
  }

  function getLineCoords(geojson) {
    if (geojson.type === 'FeatureCollection') {
      // Flatten all lines in the collection
      const coords = [];
      for (const feature of geojson.features) {
        const lineCoords = getCoords(feature);
        coords.push(...lineCoords);
      }
      return coords;
    }
    return getCoords(geojson);
  }

  function segmentIntersect(p1, p2, p3, p4) {
    const x1 = p1[0], y1 = p1[1];
    const x2 = p2[0], y2 = p2[1];
    const x3 = p3[0], y3 = p3[1];
    const x4 = p4[0], y4 = p4[1];

    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (Math.abs(denom) < 1e-12) return null; // parallel

    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
      return [x1 + ua * (x2 - x1), y1 + ua * (y2 - y1)];
    }
    return null;
  }

  function nearestPointOnLine(line, pt, options = {}) {
    const units = options.units || 'kilometers';
    const coords = getCoords(line);
    const ptCoord = getCoord(pt);

    let closestPoint = null;
    let closestDistance = Infinity;
    let closestLocation = 0;
    let totalDistance = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const start = coords[i];
      const end = coords[i + 1];
      const segmentLength = distance(point(start), point(end), { units });

      // Find closest point on segment
      const result = pointOnSegment(start, end, ptCoord);

      const d = distance(point(result.point), pt, { units });
      if (d < closestDistance) {
        closestDistance = d;
        closestPoint = result.point;
        closestLocation = totalDistance + result.t * segmentLength;
      }

      totalDistance += segmentLength;
    }

    const result = point(closestPoint, {
      dist: closestDistance,
      location: closestLocation
    });
    result.properties.index = 0;
    return result;
  }

  function pointOnSegment(start, end, pt) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
      return { point: start, t: 0 };
    }

    let t = ((pt[0] - start[0]) * dx + (pt[1] - start[1]) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    return {
      point: [start[0] + t * dx, start[1] + t * dy],
      t: t
    };
  }

  // ============================================================================
  // Buffer (simplified CSP-compatible version)
  // ============================================================================

  function buffer(geojson, radius, options = {}) {
    const units = options.units || 'kilometers';
    const geom = geojson.type === 'Feature' ? geojson.geometry : geojson;

    if (geom.type === 'LineString') {
      return bufferLineString(geom.coordinates, radius, units);
    } else if (geom.type === 'Point') {
      return bufferPoint(geom.coordinates, radius, units);
    }
    throw new Error('Unsupported geometry type for buffer: ' + geom.type);
  }

  // Note: This buffer function is kept for compatibility but is no longer used
  // for containment checking. Distance-based checking is used instead.
  function bufferLineString(coords, radius, units) {
    if (coords.length < 2) {
      return polygon([[[0,0],[0,0],[0,0],[0,0]]]);
    }

    const leftOffsets = [];
    const rightOffsets = [];

    for (let i = 0; i < coords.length; i++) {
      let bearing;
      if (i === 0) {
        bearing = rhumbBearing(point(coords[0]), point(coords[1]));
      } else if (i === coords.length - 1) {
        bearing = rhumbBearing(point(coords[i-1]), point(coords[i]));
      } else {
        const bearingIn = rhumbBearing(point(coords[i-1]), point(coords[i]));
        const bearingOut = rhumbBearing(point(coords[i]), point(coords[i+1]));
        let diff = bearingOut - bearingIn;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        bearing = bearingIn + diff / 2;
      }

      const leftBearing = bearing - 90;
      const rightBearing = bearing + 90;

      const leftPoint = rhumbDestination(point(coords[i]), radius, leftBearing, { units });
      const rightPoint = rhumbDestination(point(coords[i]), radius, rightBearing, { units });

      leftOffsets.push(leftPoint.geometry.coordinates);
      rightOffsets.push(rightPoint.geometry.coordinates);
    }

    const polygonCoords = [...leftOffsets, ...rightOffsets.reverse(), leftOffsets[0]];
    return polygon([polygonCoords]);
  }

  function bufferPoint(coord, radius, units, steps = 32) {
    const coords = [];
    for (let i = 0; i < steps; i++) {
      const bearing = (360 / steps) * i;
      const pt = rhumbDestination(point(coord), radius, bearing, { units });
      coords.push(pt.geometry.coordinates);
    }
    coords.push(coords[0]); // close ring
    return polygon([coords]);
  }

  // ============================================================================
  // Export
  // ============================================================================

  const turf = {
    point,
    lineString,
    polygon,
    featureCollection,
    bbox,
    distance,
    rhumbBearing,
    rhumbDestination,
    booleanPointInPolygon,
    polygonToLine,
    lineIntersect,
    nearestPointOnLine,
    buffer
  };

  // Export to global scope
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = turf;
  } else {
    global.turf = turf;
  }

})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
