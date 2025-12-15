// Biketerra Brunnels Extension - Content Script
// Detects bridges/tunnels from OpenStreetMap and applies them to Biketerra routes

(function() {
  'use strict';

  // ============================================================================
  // SVG Icons
  // ============================================================================

  const BRIDGE_ICON = `<svg class="bt-brunnel-icon" viewBox="0 0 147 71" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M74.5 5C39 5 35.5 24.5 5 24.5V66H19H33C36 41 46 24.5 74.5 24.5C101.5 24.5 111 40 116 66H142V24.5C111 24.5 108 5 74.5 5Z" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

  const TUNNEL_ICON = `<svg class="bt-brunnel-icon" viewBox="0 0 118 87" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M58.5 5.21033H5V81.7103H35C30.5 73.5 26.5 66 26.5 53.2103C26.5 34 42.5 20 60 20C77.5 20 92.5 33.5 92.5 53.2103C92.5 66 89.5 74.5 83 81.7103H112.5V5.21033H58.5Z" stroke-width="10" stroke-linejoin="round"/>
</svg>`;

  // ============================================================================
  // Panel State
  // ============================================================================

  let panelElement = null;
  let locatedBrunnels = [];
  let appliedBrunnelIds = new Set();
  let totalDistance = 0;

  // ============================================================================
  // Turf.js CSP-compatible subset loaded via manifest content_scripts
  // ============================================================================

  // turf-csp.js is loaded before this file and exports to global turf
  function loadTurf() {
    if (typeof turf !== 'undefined') {
      return Promise.resolve();
    }
    throw new Error('Turf.js not loaded. Check manifest.json content_scripts order.');
  }

  // ============================================================================
  // Coordinate Utilities
  // ============================================================================

  const CoordinateUtils = {
    toTurfCoords(coords) {
      return coords.map(coord => [coord.lon, coord.lat]);
    }
  };

  // ============================================================================
  // Geometry Utilities (adapted from brunnels-js)
  // ============================================================================

  const GeometryUtils = {
    // Extract cumulative distances from Biketerra's embedded route data
    // Each coordinate has a 'distance' property with cumulative meters
    calculateCumulativeDistances(routeCoords) {
      return routeCoords.map(coord => coord.distance);
    },

    // Distance-based containment check (avoids problematic buffer polygon)
    // Returns true if all brunnel points are within bufferMeters of the route
    brunnelWithinDistance(brunnel, route, bufferMeters) {
      const bufferKm = bufferMeters / 1000;
      const routeLine = route.turfLineString;

      for (const brunnelPoint of brunnel.turfPoints) {
        const nearest = turf.nearestPointOnLine(routeLine, brunnelPoint);
        const dist = turf.distance(brunnelPoint, nearest, { units: 'kilometers' });
        if (dist > bufferKm) {
          return false;
        }
      }
      return true;
    },

    // Calculate route span using Turf for projection, but Biketerra's distances for positioning
    // This finds where on the route line the brunnel endpoints project to,
    // then uses Biketerra's embedded cumulative distances for accurate placement
    calculateRouteSpan(brunnel, route) {
      if (brunnel.geometry.length === 0) return null;

      const routeLine = route.turfLineString;
      const startPoint = brunnel.turfPoints[0];
      const endPoint = brunnel.turfPoints[brunnel.turfPoints.length - 1];

      // Use Turf to find projection point and segment index
      const startNearest = turf.nearestPointOnLine(routeLine, startPoint);
      const endNearest = turf.nearestPointOnLine(routeLine, endPoint);

      // Convert Turf's location (based on its distance calc) to Biketerra's distances
      // by finding which segment we're on and interpolating
      const startDistance = this.turfLocationToBiketerraDistance(startNearest, route);
      const endDistance = this.turfLocationToBiketerraDistance(endNearest, route);

      return {
        startDistance: Math.min(startDistance, endDistance),
        endDistance: Math.max(startDistance, endDistance)
      };
    },

    // Convert a Turf nearestPointOnLine result to Biketerra's distance system
    // Uses Turf's calculated location (km) and maps it to Biketerra's distance scale
    turfLocationToBiketerraDistance(nearestResult, route) {
      // Turf's location is in km along the route (using Haversine)
      const turfLocationKm = nearestResult.properties.location;

      // We need to find which segment this falls into using Biketerra's distances
      // and interpolate within that segment
      const coords = route.coordinates;

      // Build cumulative Turf distances for comparison
      // (we need to find where turfLocationKm falls in terms of segment index)
      let turfCumulative = 0;
      let segmentIndex = 0;

      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const segmentDist = turf.distance(
          turf.point([p1.lon, p1.lat]),
          turf.point([p2.lon, p2.lat]),
          { units: 'kilometers' }
        );

        if (turfCumulative + segmentDist >= turfLocationKm) {
          segmentIndex = i;
          break;
        }
        turfCumulative += segmentDist;
        segmentIndex = i + 1;
      }

      // Clamp to valid range
      segmentIndex = Math.min(segmentIndex, coords.length - 2);

      const p1 = coords[segmentIndex];
      const p2 = coords[segmentIndex + 1];

      // Calculate how far along this segment (using Turf distances)
      const segmentStartTurf = turfCumulative;
      const segmentLengthTurf = turf.distance(
        turf.point([p1.lon, p1.lat]),
        turf.point([p2.lon, p2.lat]),
        { units: 'kilometers' }
      );

      let t = 0;
      if (segmentLengthTurf > 0) {
        t = Math.min(1, Math.max(0, (turfLocationKm - segmentStartTurf) / segmentLengthTurf));
      }

      // Interpolate using Biketerra's distances
      const dist1 = p1.distance; // meters
      const dist2 = p2.distance; // meters
      const interpolatedDistance = dist1 + t * (dist2 - dist1);


      // Return in km
      return interpolatedDistance / 1000;
    },

    getRouteSegment(routeCoords, cumulativeDistances, startDist, endDist) {
      if (startDist >= endDist || startDist < 0) return [];

      const startDistMeters = startDist * 1000;
      const endDistMeters = endDist * 1000;

      let startIndex = -1;
      let endIndex = -1;

      for (let i = 0; i < cumulativeDistances.length; i++) {
        const currentDistance = cumulativeDistances[i];

        if (startIndex === -1 && currentDistance >= startDistMeters) {
          startIndex = Math.max(0, i - 1);
        }

        if (currentDistance >= endDistMeters) {
          endIndex = Math.min(routeCoords.length - 1, i + 1);
          break;
        }
      }

      if (endIndex === -1) endIndex = routeCoords.length - 1;
      if (startIndex === -1) return [];

      return routeCoords.slice(startIndex, endIndex + 1);
    },

    isBrunnelAligned(brunnel, routeCoords, cumulativeDistances, routeSpan, toleranceDegrees) {
      if (brunnel.geometry.length < 2 || routeCoords.length < 2 || !routeSpan) {
        return true;
      }

      const routeSegment = this.getRouteSegment(
        routeCoords, cumulativeDistances, routeSpan.startDistance, routeSpan.endDistance
      );

      if (routeSegment.length < 2) return true;

      for (let i = 0; i < brunnel.turfPoints.length - 1; i++) {
        const brunnelStart = brunnel.turfPoints[i];
        const brunnelEnd = brunnel.turfPoints[i + 1];
        const brunnelBearing = turf.rhumbBearing(brunnelStart, brunnelEnd);

        for (let j = 0; j < routeSegment.length - 1; j++) {
          const routeStart = turf.point(CoordinateUtils.toTurfCoords([routeSegment[j]])[0]);
          const routeEnd = turf.point(CoordinateUtils.toTurfCoords([routeSegment[j + 1]])[0]);
          const routeBearing = turf.rhumbBearing(routeStart, routeEnd);

          const bearingDiff = this.getBearingDifference(brunnelBearing, routeBearing);

          if (bearingDiff <= toleranceDegrees) return true;
        }
      }

      return false;
    },

    getBearingDifference(bearing1, bearing2) {
      let diff = Math.abs(bearing1 - bearing2);
      if (diff > 180) diff = 360 - diff;
      if (diff > 90) diff = Math.abs(180 - diff);
      return diff;
    },

    calculateBounds(coords) {
      const points = CoordinateUtils.toTurfCoords(coords).map(coord => turf.point(coord));
      const bbox = turf.bbox(turf.featureCollection(points));

      return {
        minLon: bbox[0],
        minLat: bbox[1],
        maxLon: bbox[2],
        maxLat: bbox[3]
      };
    },

    expandBounds(bounds, bufferMeters) {
      const centerLat = (bounds.minLat + bounds.maxLat) / 2;
      const latBuffer = bufferMeters / 111320;
      const lonBuffer = bufferMeters / (111320 * Math.cos(centerLat * Math.PI / 180));

      return {
        minLat: bounds.minLat - latBuffer,
        maxLat: bounds.maxLat + latBuffer,
        minLon: bounds.minLon - lonBuffer,
        maxLon: bounds.maxLon + lonBuffer
      };
    },

    isValidCoordinate(lat, lon) {
      return typeof lat === 'number' && typeof lon === 'number' &&
        !isNaN(lat) && !isNaN(lon) &&
        lat >= -80 && lat <= 80 &&
        lon >= -180 && lon <= 180;
    },

    validateGeometry(geometry) {
      const validCoords = [];
      for (const node of geometry) {
        if (this.isValidCoordinate(node.lat, node.lon)) {
          validCoords.push({ lat: node.lat, lon: node.lon });
        }
      }
      return validCoords.length >= 2 ? validCoords : null;
    }
  };

  // ============================================================================
  // Overpass API (adapted from brunnels-js)
  // ============================================================================

  const OverpassAPI = {
    OVERPASS_URL: 'https://overpass-api.de/api/interpreter',

    async queryBrunnels(bounds, options = {}) {
      const { timeout = 30 } = options;
      const query = this.buildOverpassQuery(bounds, timeout);

      const response = await fetch(this.OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`
      });

      if (!response.ok) {
        throw new Error(`Overpass API error: ${response.status}`);
      }

      const data = await response.json();
      return this.processOverpassData(data);
    },

    buildOverpassQuery(bounds, timeout) {
      const { minLat, minLon, maxLat, maxLon } = bounds;
      const baseFilters = '[!waterway]["bicycle"!="no"]';
      const activeRailwayTypes = 'rail|light_rail|subway|tram|narrow_gauge|funicular|monorail|miniature|preserved';
      const railwayExclusion = `["railway"~"^(${activeRailwayTypes})$"]${baseFilters}(if:!is_closed());`;

      return `[out:json][timeout:${timeout}][bbox:${minLat},${minLon},${maxLat},${maxLon}];
(
  (
    way[bridge]${baseFilters}(if:!is_closed());
    - way[bridge]${railwayExclusion}
  );
  way[bridge][highway=cycleway](if:!is_closed());
);
out count;
out geom qt;
(
  (
    way[tunnel]${baseFilters}(if:!is_closed());
    - way[tunnel]${railwayExclusion}
  );
  way[tunnel][highway=cycleway](if:!is_closed());
);
out count;
out geom qt;`;
    },

    processOverpassData(data) {
      const brunnels = { bridges: [], tunnels: [] };
      if (!data.elements) return brunnels;

      let currentType = null;

      for (const element of data.elements) {
        if (element.type === 'count') {
          currentType = currentType === 'bridges' ? 'tunnels' : 'bridges';
        } else if (element.type === 'way' && element.geometry) {
          if (element.geometry.length < 2) continue;

          const validGeometry = GeometryUtils.validateGeometry(element.geometry);
          if (!validGeometry) continue;

          const brunnel = {
            id: element.id,
            tags: element.tags || {},
            geometry: validGeometry,
            nodes: element.nodes || [],
            type: currentType === 'bridges' ? 'bridge' : 'tunnel',
            name: this.extractName(element.tags)
          };

          if (currentType === 'bridges') {
            brunnels.bridges.push(brunnel);
          } else if (currentType === 'tunnels') {
            brunnels.tunnels.push(brunnel);
          }
        }
      }

      return brunnels;
    },

    extractName(tags) {
      const nameKeys = ['name', 'name:en', 'ref', 'bridge:name', 'tunnel:name'];
      for (const key of nameKeys) {
        if (tags[key]) return tags[key];
      }

      const type = tags.bridge ? 'Bridge' : 'Tunnel';
      if (tags.highway) {
        const highway = tags.highway.charAt(0).toUpperCase() + tags.highway.slice(1);
        return highway;
      }
      return type;
    }
  };

  // ============================================================================
  // Brunnel Class (adapted from brunnels-js)
  // ============================================================================

  class Brunnel {
    constructor(data) {
      this.id = data.id;
      this.type = data.type;
      this.name = data.name;
      this.tags = data.tags;
      this.geometry = data.geometry;
      this.turfLineString = turf.lineString(CoordinateUtils.toTurfCoords(this.geometry));
      this.turfPoints = this.geometry.map(coord =>
        turf.point(CoordinateUtils.toTurfCoords([coord])[0])
      );
      this.nodes = data.nodes || [];
      this.routeSpan = null;
      this.exclusionReason = null;
    }

    static fromOverpassData(overpassData) {
      const brunnels = [];

      for (const bridge of overpassData.bridges) {
        brunnels.push(new Brunnel({
          id: bridge.id,
          type: 'bridge',
          name: bridge.name,
          tags: bridge.tags,
          geometry: bridge.geometry,
          nodes: bridge.nodes || []
        }));
      }

      for (const tunnel of overpassData.tunnels) {
        brunnels.push(new Brunnel({
          id: tunnel.id,
          type: 'tunnel',
          name: tunnel.name,
          tags: tunnel.tags,
          geometry: tunnel.geometry,
          nodes: tunnel.nodes || []
        }));
      }

      return brunnels;
    }

    isWithinDistance(route, bufferMeters) {
      return GeometryUtils.brunnelWithinDistance(this, route, bufferMeters);
    }

    calculateRouteSpan(route) {
      this.routeSpan = GeometryUtils.calculateRouteSpan(this, route);
    }

    isAligned(routeCoords, cumulativeDistances, toleranceDegrees) {
      if (!this.routeSpan) return true;
      return GeometryUtils.isBrunnelAligned(
        this, routeCoords, cumulativeDistances, this.routeSpan, toleranceDegrees
      );
    }

    isIncluded() {
      return this.exclusionReason === null;
    }
  }

  // ============================================================================
  // Brunnel Analysis (adapted from brunnels-js)
  // ============================================================================

  const BrunnelAnalysis = {
    filterContained(brunnels, route, bufferMeters) {
      return brunnels.filter(brunnel => {
        const isWithin = brunnel.isWithinDistance(route, bufferMeters);
        if (!isWithin) brunnel.exclusionReason = 'outlier';
        return isWithin;
      });
    },

    calculateRouteSpans(brunnels, route) {
      for (const brunnel of brunnels) {
        brunnel.calculateRouteSpan(route);
      }
    },

    filterAligned(brunnels, routeCoords, cumulativeDistances, toleranceDegrees) {
      for (const brunnel of brunnels) {
        if (brunnel.isIncluded()) {
          if (!brunnel.isAligned(routeCoords, cumulativeDistances, toleranceDegrees)) {
            brunnel.exclusionReason = 'misaligned';
          }
        }
      }
    },

    handleOverlaps(brunnels, route) {
      const includedBrunnels = brunnels.filter(b => b.isIncluded() && b.routeSpan);
      const overlapGroups = [];

      for (const brunnel of includedBrunnels) {
        let foundGroup = false;

        for (const group of overlapGroups) {
          const overlaps = group.some(other => this.routeSpansOverlap(brunnel.routeSpan, other.routeSpan));
          if (overlaps) {
            group.push(brunnel);
            foundGroup = true;
            break;
          }
        }

        if (!foundGroup) {
          overlapGroups.push([brunnel]);
        }
      }

      for (const group of overlapGroups) {
        if (group.length > 1) {
          const brunnelDistances = group.map(brunnel => ({
            brunnel,
            avgDistance: this._calculateAverageDistanceToRoute(brunnel, route)
          }));

          brunnelDistances.sort((a, b) => a.avgDistance - b.avgDistance);

          for (let i = 1; i < brunnelDistances.length; i++) {
            brunnelDistances[i].brunnel.exclusionReason = 'alternative';
          }
        }
      }
    },

    _calculateAverageDistanceToRoute(brunnel, route) {
      const routeLine = route.turfLineString;
      let totalDistance = 0;

      for (const brunnelPoint of brunnel.turfPoints) {
        const nearestPoint = turf.nearestPointOnLine(routeLine, brunnelPoint);
        const distance = turf.distance(brunnelPoint, nearestPoint, { units: 'meters' });
        totalDistance += distance;
      }

      return totalDistance / brunnel.geometry.length;
    },

    routeSpansOverlap(span1, span2) {
      return !(span1.endDistance <= span2.startDistance || span2.endDistance <= span1.startDistance);
    },

    // Merge adjacent brunnels of the same type (within 1m of each other)
    // OSM often divides bridges/tunnels into multiple components
    mergeAdjacentBrunnels(brunnels) {
      // Separate by type - only merge same types (never merge bridge with tunnel)
      const bridges = brunnels.filter(b => b.type === 'bridge');
      const tunnels = brunnels.filter(b => b.type === 'tunnel');

      const mergedBridges = this._mergeByType(bridges);
      const mergedTunnels = this._mergeByType(tunnels);

      return [...mergedBridges, ...mergedTunnels];
    },

    _mergeByType(brunnels) {
      if (brunnels.length === 0) return [];

      // Sort by start distance on route
      const sorted = [...brunnels].sort((a, b) =>
        (a.routeSpan?.startDistance || 0) - (b.routeSpan?.startDistance || 0)
      );

      const merged = [];
      let currentGroup = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const prev = currentGroup[currentGroup.length - 1];
        const curr = sorted[i];

        // Check if within 1m (0.001 km) of each other
        const gap = curr.routeSpan.startDistance - prev.routeSpan.endDistance;
        if (gap <= 0.001) {
          currentGroup.push(curr);
        } else {
          merged.push(this._createMergedBrunnel(currentGroup));
          currentGroup = [curr];
        }
      }

      // Don't forget the last group
      merged.push(this._createMergedBrunnel(currentGroup));

      return merged;
    },

    _createMergedBrunnel(group) {
      if (group.length === 1) return group[0];

      // Merge route span (min start to max end)
      const startDistance = Math.min(...group.map(b => b.routeSpan.startDistance));
      const endDistance = Math.max(...group.map(b => b.routeSpan.endDistance));

      // Merge names: if all match, use once; if different, join with semicolons
      const names = group.map(b => b.name);
      const uniqueNames = [...new Set(names)];
      const mergedName = uniqueNames.length === 1 ? uniqueNames[0] : uniqueNames.join('; ');

      // Use first brunnel as representative, update its span and name
      const representative = group[0];
      representative.routeSpan = { startDistance, endDistance };
      representative.name = mergedName;

      return representative;
    }
  };

  // ============================================================================
  // Biketerra Integration
  // ============================================================================

  const BiketerraIntegration = {
    // Extract route ID from the current page URL
    getRouteId() {
      const url = new URL(window.location.href);
      // URL format: https://biketerra.com/editor?id=<route_id>
      // or: https://biketerra.com/routes/new?id=<route_id>
      const id = url.searchParams.get('id');
      if (id) return id;

      // Also check path for /editor/<route_id> format
      const pathMatch = url.pathname.match(/\/editor\/(\d+)/);
      if (pathMatch) return pathMatch[1];

      return null;
    },

    // Fetch route data from Biketerra's __data.json endpoint
    async fetchRouteData() {
      const routeId = this.getRouteId();
      if (!routeId) {
        throw new Error('Could not extract route ID from URL');
      }


      // Fetch the __data.json endpoint
      const dataUrl = `https://biketerra.com/routes/new/__data.json?id=${routeId}`;
      const response = await fetch(dataUrl, {
        credentials: 'include' // Include cookies for authentication
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch route data: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return this.parseDataJson(data);
    },

    // Parse the SvelteKit __data.json format to extract route data
    // Prefers editableRoute (higher resolution) over simple_route
    parseDataJson(data) {
      // SvelteKit data format uses indexed arrays for deduplication
      // Structure: { nodes: [{ type: 'data', data: [...] }, ...] }
      if (!data.nodes || !Array.isArray(data.nodes)) {
        throw new Error('Invalid data format: missing nodes array');
      }

      // Try each data node, preferring larger arrays (more data)
      const dataNodes = data.nodes
        .filter(node => node && node.type === 'data' && Array.isArray(node.data))
        .sort((a, b) => b.data.length - a.data.length);

      for (const node of dataNodes) {
        // First try editableRoute (higher resolution with accurate distances)
        const editableRoute = this.findEditableRouteInArray(node.data);
        if (editableRoute) {
          return editableRoute;
        }
      }

      throw new Error('Could not find route data in response');
    },

    // Find editableRoute in the indexed data array
    // Returns the dereferenced array of route points
    findEditableRouteInArray(dataArray) {
      // First, find the index mapping object that contains 'editableRoute' key
      let editableRouteIndex = null;

      for (const item of dataArray) {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          if ('editableRoute' in item) {
            editableRouteIndex = item.editableRoute;
            break;
          }
        }
      }

      if (editableRouteIndex === null) {
        return this.findSimpleRouteInArray(dataArray);
      }

      // Get the editableRoute array (list of indices to point objects)
      const editableRouteIndices = dataArray[editableRouteIndex];
      if (!Array.isArray(editableRouteIndices)) {
        return this.findSimpleRouteInArray(dataArray);
      }

      // Dereference each point: each point is a list of 5 indices
      // [lat_idx, lon_idx, elev_idx, dist_idx, smoothed_elev_idx]
      const points = [];
      for (const pointIndex of editableRouteIndices) {
        const pointIndices = dataArray[pointIndex];
        if (Array.isArray(pointIndices) && pointIndices.length >= 4) {
          const lat = dataArray[pointIndices[0]];
          const lon = dataArray[pointIndices[1]];
          const elevation = dataArray[pointIndices[2]];
          const distance = dataArray[pointIndices[3]];
          points.push([lat, lon, elevation, distance]);
        }
      }

      if (points.length > 0) {
        return points;
      }

      return null;
    },

    // Fallback: find simple_route in the indexed data array
    findSimpleRouteInArray(dataArray) {
      // simple_route is stored as a JSON string
      for (const item of dataArray) {
        if (typeof item === 'string' && item.startsWith('[[')) {
          try {
            const parsed = JSON.parse(item);
            if (Array.isArray(parsed) && parsed.length > 0 &&
                Array.isArray(parsed[0]) && parsed[0].length === 4 &&
                typeof parsed[0][0] === 'number') {
              return parsed;
            }
          } catch (e) {
            // Not valid JSON, continue searching
          }
        }
      }
      return null;
    },

    // Parse route data into usable format
    parseRouteData(routePoints) {
      // Route format: [[lat, lon, elevation, cumulative_distance_meters], ...]
      const coords = routePoints.map(point => ({
        lat: point[0],
        lon: point[1],
        elevation: point[2],
        distance: point[3]
      }));

      // Distance is in meters, convert to km for totalDistance
      const totalDistance = coords[coords.length - 1].distance / 1000;

      const turfCoords = coords.map(c => [c.lon, c.lat]);
      const turfLineString = turf.lineString(turfCoords);

      return {
        coordinates: coords,
        totalDistance,
        turfLineString
      };
    },

    // Get the elevation chart element
    getElevationChart() {
      return document.querySelector('.elev-chart');
    },

    // Get the SVG element inside the elevation chart
    getElevationSvg() {
      return document.querySelector('.elev-chart .alt-svg');
    },

    // Get bridge button
    getBridgeButton() {
      const img = document.querySelector('img[src*="ico-bridge"]');
      return img ? img.closest('.toolbar-item') : null;
    },

    // Get tunnel button
    getTunnelButton() {
      const img = document.querySelector('img[src*="ico-tunnel"]');
      return img ? img.closest('.toolbar-item') : null;
    },

    // Convert distance (km) to x-position (0-1) on elevation chart
    distanceToX(distanceKm, totalDistanceKm) {
      return distanceKm / totalDistanceKm;
    },

    // Find track points within a distance range and get expanded range if needed
    // Returns { pointCount, expandedRange } where expandedRange includes surrounding points
    getTrackPointsInRange(routeCoords, startKm, endKm) {
      const startMeters = startKm * 1000;
      const endMeters = endKm * 1000;

      let firstInside = -1;
      let lastInside = -1;

      // Find track points strictly inside the range
      for (let i = 0; i < routeCoords.length; i++) {
        const dist = routeCoords[i].distance;
        if (dist >= startMeters && dist <= endMeters) {
          if (firstInside === -1) firstInside = i;
          lastInside = i;
        }
      }

      const pointCount = firstInside === -1 ? 0 : (lastInside - firstInside + 1);

      // If fewer than 2 points, find surrounding track points
      if (pointCount < 2) {
        let prevIndex = -1;
        let nextIndex = -1;

        for (let i = 0; i < routeCoords.length; i++) {
          const dist = routeCoords[i].distance;
          if (dist < startMeters) {
            prevIndex = i;
          } else if (dist > endMeters && nextIndex === -1) {
            nextIndex = i;
            break;
          }
        }

        // Default to first/last if not found
        if (prevIndex === -1) prevIndex = 0;
        if (nextIndex === -1) nextIndex = routeCoords.length - 1;

        // Extend by 1 dam (10m) before and after to ensure map zoom triggers
        const totalDistanceKm = routeCoords[routeCoords.length - 1].distance / 1000;
        const paddingKm = 0.01; // 10 meters = 1 decameter

        return {
          pointCount,
          expandedRange: {
            startKm: Math.max(0, routeCoords[prevIndex].distance / 1000 - paddingKm),
            endKm: Math.min(totalDistanceKm, routeCoords[nextIndex].distance / 1000 + paddingKm)
          }
        };
      }

      return { pointCount, expandedRange: null };
    },

    // Simulate a right-click to deselect
    async rightClickToDeselect() {
      const chart = this.getElevationChart();
      if (!chart) return;

      const rect = chart.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      chart.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 2, buttons: 2
      }));

      await new Promise(r => requestAnimationFrame(r));
    },

    // Get the current visible range of the elevation chart (in km)
    // Uses intermediate tick marks for higher precision when available
    getChartVisibleRange() {
      const firstTick = document.querySelector('.elev-scale-first-tick');
      const lastTick = document.querySelector('.elev-scale-last-tick');

      if (!firstTick || !lastTick) {
        console.warn('Could not find chart scale ticks');
        return null;
      }

      // Extract distance values from tick text (e.g., "0km", "30.29km", "14.80km")
      const parseKm = (text) => {
        const match = text.match(/([\d.]+)\s*km/i);
        return match ? parseFloat(match[1]) : null;
      };

      const startKm = parseKm(firstTick.textContent);
      const endKm = parseKm(lastTick.textContent);

      if (startKm === null || endKm === null) {
        console.warn('Could not parse chart range:', firstTick.textContent, lastTick.textContent);
        return null;
      }

      // Try to get more precise range from intermediate ticks
      const intermediateTicks = document.querySelectorAll('.elev-scale-tick');
      let percentPerKm = null;

      if (intermediateTicks.length >= 2) {
        // Parse two adjacent ticks to calculate precise ratio
        const tickData = [];
        for (const tick of intermediateTicks) {
          const leftMatch = tick.style.left.match(/([\d.]+)%/);
          const label = tick.querySelector('.elev-scale-tick-label');
          if (leftMatch && label) {
            const leftPercent = parseFloat(leftMatch[1]);
            const km = parseKm(label.textContent);
            if (km !== null) {
              tickData.push({ leftPercent, km });
            }
          }
        }

        if (tickData.length >= 2) {
          // Calculate percent per km from two ticks
          const t1 = tickData[0];
          const t2 = tickData[1];
          const deltaPercent = t2.leftPercent - t1.leftPercent;
          const deltaKm = t2.km - t1.km;
          if (deltaKm > 0) {
            percentPerKm = deltaPercent / deltaKm;
            // Calculate more precise start/end using tick data
            const preciseStartKm = t1.km - (t1.leftPercent / percentPerKm);
            const preciseEndKm = t1.km + ((100 - t1.leftPercent) / percentPerKm);

            return {
              startKm: preciseStartKm,
              endKm: preciseEndKm,
              rangeKm: preciseEndKm - preciseStartKm,
              percentPerKm,
              precise: true
            };
          }
        }
      }

      return { startKm, endKm, rangeKm: endKm - startKm, precise: false };
    },

    // Trigger mouse interaction to update chart labels
    async triggerChartUpdate() {
      const chart = this.getElevationChart();
      if (!chart) return;

      const rect = chart.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Move mouse into chart to trigger label update
      chart.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, clientX: centerX, clientY: centerY, view: window
      }));
      chart.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: centerX, clientY: centerY, view: window
      }));
      await new Promise(r => requestAnimationFrame(r));
    },

    // Clear any existing selection
    async clearSelection() {
      const chart = this.getElevationChart();
      if (!chart) return;

      // Click somewhere on the chart without shift to deselect
      const rect = chart.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Make sure shift is not pressed
      window.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: false, view: window
      }));

      // Simple click to deselect
      chart.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 0, buttons: 1, shiftKey: false
      }));
      chart.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 0, buttons: 0, shiftKey: false
      }));

      await new Promise(r => requestAnimationFrame(r));
    },

    // Simulate selection on elevation chart with precise positioning
    // Uses the visible range from chart scale ticks for accurate km-to-pixel conversion
    // If visibleRange is provided, skips the chart update (for batch operations)
    async simulateSelection(startKm, endKm, totalDistanceKm, visibleRange = null) {
      const chart = this.getElevationChart();
      if (!chart) throw new Error('Elevation chart not found');

      // Clear any existing selection first (skip if we have cached visibleRange)
      if (!visibleRange) {
        await this.clearSelection();
        // Trigger chart update to ensure labels reflect current zoom
        await this.triggerChartUpdate();
      }

      const rect = chart.getBoundingClientRect();
      if (!visibleRange) {
        visibleRange = this.getChartVisibleRange();
      }

      if (!visibleRange) {
        console.warn('Could not get visible range, falling back to full route');
        // Fall back to assuming full route is visible
        const startX = startKm / totalDistanceKm;
        const endX = endKm / totalDistanceKm;
        const startPx = rect.left + (startX * rect.width);
        const endPx = rect.left + (endX * rect.width);
        const centerY = rect.top + (rect.height / 2);
        return this._performSelection(chart, rect, startPx, endPx, centerY);
      }


      // Calculate pixel positions based on visible range
      // Use percentPerKm if available for higher precision
      let startPx, endPx;
      if (visibleRange.percentPerKm) {
        // High precision: use the calculated percent per km
        const startPercent = (startKm - visibleRange.startKm) * visibleRange.percentPerKm;
        const endPercent = (endKm - visibleRange.startKm) * visibleRange.percentPerKm;
        startPx = rect.left + (startPercent / 100) * rect.width;
        endPx = rect.left + (endPercent / 100) * rect.width;
      } else {
        // Standard precision: use start/end range
        const startRelative = (startKm - visibleRange.startKm) / visibleRange.rangeKm;
        const endRelative = (endKm - visibleRange.startKm) / visibleRange.rangeKm;
        startPx = rect.left + (startRelative * rect.width);
        endPx = rect.left + (endRelative * rect.width);
      }

      const centerY = rect.top + (rect.height / 2);
      const pixelWidth = endPx - startPx;
      const metersPerPixel = (visibleRange.rangeKm * 1000) / rect.width;


      // IMPORTANT: First move mouse to start position WITHOUT shift
      // This ensures Svelte's internal cursor position is at our start
      chart.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, clientX: startPx, clientY: centerY, view: window
      }));
      chart.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: startPx, clientY: centerY, view: window, shiftKey: false
      }));
      await new Promise(r => requestAnimationFrame(r));

      // Now press Shift - this should enable selection mode at current cursor position
      window.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true, view: window
      }));
      await new Promise(r => requestAnimationFrame(r));


      // Mouse down at start (this anchors the selection start)
      chart.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: startPx, clientY: centerY,
        button: 0, buttons: 1, shiftKey: true
      }));
      await new Promise(r => requestAnimationFrame(r));

      // Drag to end position - this extends the selection
      const dragSteps = 15;
      for (let i = 1; i <= dragSteps; i++) {
        const x = startPx + (endPx - startPx) * (i / dragSteps);
        chart.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: centerY,
          button: 0, buttons: 1, shiftKey: true
        }));
        await new Promise(r => requestAnimationFrame(r));
      }


      // Mouse up at end position - this finalizes the selection
      chart.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: endPx, clientY: centerY,
        button: 0, buttons: 0, shiftKey: true
      }));
      await new Promise(r => requestAnimationFrame(r));

      // Keep shift held for a moment, then release
      window.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: false, view: window
      }));
      await new Promise(r => requestAnimationFrame(r));


      // Log button states
      const bridgeBtn = this.getBridgeButton();
    },

    // Click the bridge or tunnel button
    async clickBrunnelButton(type) {
      const button = type === 'bridge' ? this.getBridgeButton() : this.getTunnelButton();
      if (!button) {
        console.error(`${type} button not found`);
        throw new Error(`${type} button not found`);
      }


      // Find all clickable elements within the button
      const img = button.querySelector('img');
      const icon = button.querySelector('.toolbar-item-icon');


      // Try dispatching a proper mouse click event instead of .click()
      const clickTarget = img || icon || button;
      const rect = clickTarget.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;


      // Dispatch mousedown, mouseup, click sequence
      const mouseDown = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 0, buttons: 1
      });
      const mouseUp = new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 0, buttons: 0
      });
      const click = new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX: centerX, clientY: centerY,
        button: 0
      });

      clickTarget.dispatchEvent(mouseDown);
      await new Promise(r => requestAnimationFrame(r));
      clickTarget.dispatchEvent(mouseUp);
      await new Promise(r => requestAnimationFrame(r));
      clickTarget.dispatchEvent(click);

      // Wait for UI to update
      await new Promise(resolve => setTimeout(resolve, 1));
    },

    // Zoom the chart to show a specific brunnel
    // Returns the visible range after zooming, or null on error
    async zoomToBrunnel(brunnel) {
      const chart = this.getElevationChart();
      if (!chart) return null;

      // Calculate midpoint for centering zoom
      const midpointKm = (brunnel.startDistance + brunnel.endDistance) / 2;

      // Get the visible range and zoom if needed
      await this.triggerChartUpdate();
      let visibleRange = this.getChartVisibleRange();

      if (!visibleRange) return null;

      const maxRangeKm = 1.0;
      let iterations = 0;
      const maxIterations = 50;

      // Phase 1: Zoom OUT until target is in visible range
      while ((midpointKm < visibleRange.startKm || midpointKm > visibleRange.endKm) && iterations < maxIterations) {
        const rect = chart.getBoundingClientRect();
        const centerY = rect.top + rect.height / 2;

        // Zoom out from the edge farthest from target
        let zoomPx;
        if (midpointKm < visibleRange.startKm) {
          zoomPx = rect.right - 10;
        } else {
          zoomPx = rect.left + 10;
        }

        chart.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: zoomPx, clientY: centerY,
          deltaY: 120, deltaMode: 0
        }));

        await new Promise(r => requestAnimationFrame(r));
        await this.triggerChartUpdate();
        visibleRange = this.getChartVisibleRange();
        if (!visibleRange) return null;
        iterations++;
      }

      // Phase 2: Zoom IN centered on target until range is <= 1km
      while (visibleRange.rangeKm > maxRangeKm && iterations < maxIterations) {
        const rect = chart.getBoundingClientRect();

        let zoomCenterPx;
        if (visibleRange.percentPerKm) {
          const percent = (midpointKm - visibleRange.startKm) * visibleRange.percentPerKm;
          zoomCenterPx = rect.left + (percent / 100) * rect.width;
        } else {
          const relative = (midpointKm - visibleRange.startKm) / visibleRange.rangeKm;
          zoomCenterPx = rect.left + relative * rect.width;
        }
        zoomCenterPx = Math.max(rect.left, Math.min(rect.right, zoomCenterPx));
        const centerY = rect.top + rect.height / 2;

        chart.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: zoomCenterPx, clientY: centerY, view: window
        }));
        await new Promise(r => requestAnimationFrame(r));

        chart.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: zoomCenterPx, clientY: centerY,
          deltaY: -120, deltaMode: 0
        }));

        await new Promise(r => requestAnimationFrame(r));
        await this.triggerChartUpdate();
        visibleRange = this.getChartVisibleRange();
        if (!visibleRange) return null;
        iterations++;
      }

      return visibleRange;
    },

    // Apply a single brunnel with zoom to ensure visibility
    // routeCoords is required for track point workaround
    async applyBrunnel(brunnel, routeCoords) {
      const startKm = brunnel.startDistance;
      const endKm = brunnel.endDistance;

      // Zoom to show this brunnel
      const visibleRange = await this.zoomToBrunnel(brunnel);
      if (!visibleRange) {
        throw new Error('Could not zoom to brunnel');
      }

      // Check if routespan contains at least 2 track points
      const trackPointInfo = this.getTrackPointsInRange(routeCoords, startKm, endKm);

      // If fewer than 2 track points, do the wider selection workaround
      if (trackPointInfo.expandedRange) {
        // First select the expanded range (triggers map zoom)
        await this.simulateSelection(
          trackPointInfo.expandedRange.startKm,
          trackPointInfo.expandedRange.endKm,
          null, visibleRange
        );
        // Right-click to deselect
        await this.rightClickToDeselect();
      }

      // Make the selection using actual km values
      await this.simulateSelection(startKm, endKm, null, visibleRange);

      // Click the appropriate button
      await this.clickBrunnelButton(brunnel.type);
    },

    // Apply multiple brunnels, zooming to each one
    async applyAllBrunnels(brunnels, routeCoords) {
      if (brunnels.length === 0) return;

      // Apply each brunnel with zoom
      for (const brunnel of brunnels) {
        await this.applyBrunnel(brunnel, routeCoords);
      }
    }
  };

  // ============================================================================
  // Overlay Panel UI
  // ============================================================================

  function createPanel() {
    if (panelElement) return panelElement;

    const panel = document.createElement('div');
    panel.className = 'bt-brunnels-panel hidden';
    panel.innerHTML = `
      <div class="bt-brunnels-header">
        <span>Biketerra Brunnels</span>
        <button class="bt-brunnels-close" title="Close">&times;</button>
      </div>
      <div class="bt-brunnels-body">
        <div class="bt-brunnels-status">Ready. Click "Locate Brunnels" to find bridges and tunnels on this route.</div>

        <div class="bt-brunnels-options">
          <div class="bt-option-row">
            <label for="bt-queryBuffer">Query buffer (m)</label>
            <input type="number" id="bt-queryBuffer" value="10" min="5" max="50">
          </div>
          <div class="bt-option-row">
            <label for="bt-routeBuffer">Route buffer (m)</label>
            <input type="number" id="bt-routeBuffer" value="3" min="1" max="20">
          </div>
          <div class="bt-option-row">
            <label for="bt-bearingTolerance">Bearing tolerance</label>
            <input type="number" id="bt-bearingTolerance" value="20" min="5" max="45">
          </div>
        </div>

        <div class="bt-brunnels-actions">
          <button id="bt-locateBtn" class="bt-brunnels-btn primary">Locate Brunnels</button>
          <button id="bt-applyBtn" class="bt-brunnels-btn primary" disabled>Apply All to Route</button>
        </div>

        <div id="bt-progress" class="bt-brunnels-progress" style="display: none;"></div>

        <div id="bt-results" class="bt-brunnels-results"></div>
      </div>
    `;

    document.body.appendChild(panel);
    panelElement = panel;

    // Event listeners
    panel.querySelector('.bt-brunnels-close').addEventListener('click', hidePanel);
    panel.querySelector('#bt-locateBtn').addEventListener('click', handleLocateBrunnels);
    panel.querySelector('#bt-applyBtn').addEventListener('click', handleApplyAllBrunnels);

    // Re-enable Locate button when options change
    const locateBtn = panel.querySelector('#bt-locateBtn');
    for (const input of panel.querySelectorAll('.bt-brunnels-options input')) {
      input.addEventListener('input', () => {
        locateBtn.disabled = false;
      });
    }

    // Drag functionality
    const header = panel.querySelector('.bt-brunnels-header');
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener('mousedown', (e) => {
      // Don't drag when clicking the close button
      if (e.target.closest('.bt-brunnels-close')) return;

      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;

      // Prevent text selection while dragging
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;

      // Keep panel within viewport bounds
      const maxX = window.innerWidth - panel.offsetWidth;
      const maxY = window.innerHeight - panel.offsetHeight;

      panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
      panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
      panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });

    return panel;
  }

  function showPanel() {
    const panel = createPanel();
    panel.classList.remove('hidden');
  }

  function hidePanel() {
    if (panelElement) {
      panelElement.classList.add('hidden');
    }
  }

  function togglePanel() {
    const panel = createPanel();
    panel.classList.toggle('hidden');
  }

  function updateStatus(text, type = '') {
    const status = panelElement?.querySelector('.bt-brunnels-status');
    if (status) {
      status.textContent = text;
      status.className = 'bt-brunnels-status' + (type ? ' ' + type : '');
    }
  }

  function showProgress(text) {
    const progress = panelElement?.querySelector('#bt-progress');
    if (progress) {
      progress.textContent = text;
      progress.style.display = 'block';
    }
  }

  function hideProgress() {
    const progress = panelElement?.querySelector('#bt-progress');
    if (progress) {
      progress.style.display = 'none';
    }
  }

  function displayResults(brunnels, distance) {
    const resultsDiv = panelElement?.querySelector('#bt-results');
    if (!resultsDiv) return;

    resultsDiv.innerHTML = '';

    if (brunnels.length === 0) {
      resultsDiv.innerHTML = '<p class="bt-empty-message">No brunnels found on this route.</p>';
      return;
    }

    // Sort by start distance
    const sorted = [...brunnels].sort((a, b) => a.startDistance - b.startDistance);

    for (const brunnel of sorted) {
      const item = document.createElement('div');
      item.className = `bt-brunnel-item ${brunnel.type}`;
      item.dataset.id = brunnel.id;

      const startKm = brunnel.startDistance.toFixed(2);
      const endKm = brunnel.endDistance.toFixed(2);
      const lengthM = ((brunnel.endDistance - brunnel.startDistance) * 1000).toFixed(0);

      const icon = brunnel.type === 'bridge' ? BRIDGE_ICON : TUNNEL_ICON;
      item.innerHTML = `
        ${icon}
        <div class="bt-brunnel-info">
          <div class="bt-brunnel-name">${brunnel.name}</div>
          <div class="bt-brunnel-span">${startKm} - ${endKm} km (${lengthM}m)</div>
        </div>
      `;

      item.addEventListener('click', () => handleApplySingleBrunnel(brunnel, item));
      resultsDiv.appendChild(item);
    }
  }

  async function handleLocateBrunnels() {
    const locateBtn = panelElement?.querySelector('#bt-locateBtn');
    const applyBtn = panelElement?.querySelector('#bt-applyBtn');

    const queryBuffer = parseInt(panelElement?.querySelector('#bt-queryBuffer')?.value) || 10;
    const routeBuffer = parseInt(panelElement?.querySelector('#bt-routeBuffer')?.value) || 3;
    const bearingTolerance = parseInt(panelElement?.querySelector('#bt-bearingTolerance')?.value) || 20;

    updateStatus('Locating brunnels...', 'loading');
    showProgress('Extracting route data...');
    if (locateBtn) locateBtn.disabled = true;

    try {
      const result = await locateBrunnels({ queryBuffer, routeBuffer, bearingTolerance });

      locatedBrunnels = result.brunnels;
      totalDistance = result.totalDistance;
      appliedBrunnelIds = new Set();

      displayResults(locatedBrunnels, totalDistance);

      updateStatus(`Found ${locatedBrunnels.length} brunnel(s). Click to apply individually.`, 'success');
      if (applyBtn) applyBtn.disabled = locatedBrunnels.length === 0;
      hideProgress();
    } catch (error) {
      updateStatus(`Error: ${error.message}`, 'error');
      hideProgress();
      if (locateBtn) locateBtn.disabled = false;
    }
  }

  async function handleApplySingleBrunnel(brunnel, item) {
    // Skip if already applied
    if (appliedBrunnelIds.has(brunnel.id)) return;

    const applyBtn = panelElement?.querySelector('#bt-applyBtn');

    updateStatus(`Applying ${brunnel.name}...`, 'loading');

    try {
      await loadTurf();

      // Fetch route data for track point workaround
      const simpleRoute = await BiketerraIntegration.fetchRouteData();
      const route = BiketerraIntegration.parseRouteData(simpleRoute);

      // Apply the brunnel (handles zoom and track point workaround)
      await BiketerraIntegration.applyBrunnel(brunnel, route.coordinates);

      // Mark as applied
      appliedBrunnelIds.add(brunnel.id);
      item.classList.add('applied');

      // Update status
      const remaining = locatedBrunnels.length - appliedBrunnelIds.size;
      if (remaining === 0) {
        updateStatus(`All ${locatedBrunnels.length} brunnel(s) applied!`, 'success');
        if (applyBtn) applyBtn.disabled = true;
      } else {
        updateStatus(`Applied ${brunnel.name}. ${remaining} remaining.`, 'success');
      }
    } catch (error) {
      updateStatus(`Error: ${error.message}`, 'error');
    }
  }

  async function handleApplyAllBrunnels() {
    const applyBtn = panelElement?.querySelector('#bt-applyBtn');

    // Filter to only non-applied brunnels
    const remaining = locatedBrunnels.filter(b => !appliedBrunnelIds.has(b.id));

    if (remaining.length === 0) {
      if (applyBtn) applyBtn.disabled = true;
      return;
    }

    updateStatus('Applying brunnels...', 'loading');
    showProgress(`Applying ${remaining.length} brunnels with precision zoom...`);
    if (applyBtn) applyBtn.disabled = true;

    try {
      await loadTurf();
      const simpleRoute = await BiketerraIntegration.fetchRouteData();
      const route = BiketerraIntegration.parseRouteData(simpleRoute);

      // Sort by start distance
      const sorted = [...remaining].sort((a, b) => a.startDistance - b.startDistance);

      await BiketerraIntegration.applyAllBrunnels(sorted, route.coordinates);

      // Mark all as applied in UI
      for (const brunnel of sorted) {
        appliedBrunnelIds.add(brunnel.id);
        const item = panelElement?.querySelector(`.bt-brunnel-item[data-id="${brunnel.id}"]`);
        if (item) item.classList.add('applied');
      }

      updateStatus(`Applied ${sorted.length} brunnel(s) successfully!`, 'success');
      hideProgress();
    } catch (error) {
      updateStatus(`Error: ${error.message}`, 'error');
      hideProgress();
      if (applyBtn) applyBtn.disabled = false;
    }
  }

  // ============================================================================
  // Main Location Pipeline
  // ============================================================================

  async function locateBrunnels(options = {}) {
    const { queryBuffer = 10, routeBuffer = 3, bearingTolerance = 20 } = options;

    // Load Turf.js
    await loadTurf();

    // Fetch route data from Biketerra API
    const simpleRoute = await BiketerraIntegration.fetchRouteData();
    const route = BiketerraIntegration.parseRouteData(simpleRoute);

    // Calculate bounds and query Overpass
    const bounds = GeometryUtils.calculateBounds(route.coordinates);
    const expandedBounds = GeometryUtils.expandBounds(bounds, queryBuffer);

    showProgress('Querying OpenStreetMap...');
    const overpassData = await OverpassAPI.queryBrunnels(expandedBounds);

    // Create Brunnel instances
    const brunnels = Brunnel.fromOverpassData(overpassData);

    // Filter by containment (distance-based, avoids buffer polygon issues)
    BrunnelAnalysis.filterContained(brunnels, route, routeBuffer);

    // Calculate route spans
    BrunnelAnalysis.calculateRouteSpans(brunnels, route);

    // Calculate cumulative distances for alignment check
    const cumulativeDistances = GeometryUtils.calculateCumulativeDistances(route.coordinates);

    // Filter by alignment
    BrunnelAnalysis.filterAligned(brunnels, route.coordinates, cumulativeDistances, bearingTolerance);

    // Handle overlaps
    BrunnelAnalysis.handleOverlaps(brunnels, route);

    // Get included brunnels
    const includedBrunnels = brunnels.filter(b => b.isIncluded() && b.routeSpan);

    // Merge adjacent brunnels of the same type (within 1m)
    // OSM often divides bridges/tunnels into multiple components
    const mergedBrunnels = BrunnelAnalysis.mergeAdjacentBrunnels(includedBrunnels);

    // Return simplified data for popup
    return {
      brunnels: mergedBrunnels.map(b => ({
        id: b.id,
        type: b.type,
        name: b.name,
        startDistance: b.routeSpan.startDistance,
        endDistance: b.routeSpan.endDistance
      })),
      totalDistance: route.totalDistance
    };
  }

  // ============================================================================
  // Message Handler
  // ============================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'togglePanel') {
      togglePanel();
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'showPanel') {
      showPanel();
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'hidePanel') {
      hidePanel();
      sendResponse({ success: true });
      return false;
    }

    if (message.action === 'locateBrunnels') {
      locateBrunnels(message.options)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ error: error.message }));
      return true; // Async response
    }

    if (message.action === 'applyBrunnel') {
      (async () => {
        try {
          await loadTurf();
          const simpleRoute = await BiketerraIntegration.fetchRouteData();
          const route = BiketerraIntegration.parseRouteData(simpleRoute);
          await BiketerraIntegration.applyBrunnel(message.brunnel, route.coordinates);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
      })();
      return true;
    }

    if (message.action === 'applyAllBrunnels') {
      (async () => {
        try {
          await loadTurf();
          const simpleRoute = await BiketerraIntegration.fetchRouteData();
          const route = BiketerraIntegration.parseRouteData(simpleRoute);
          await BiketerraIntegration.applyAllBrunnels(message.brunnels, route.coordinates);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
      })();
      return true;
    }

  });

})();
