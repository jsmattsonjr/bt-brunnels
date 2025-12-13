// Biketerra Brunnels Extension - Content Script
// Detects bridges/tunnels from OpenStreetMap and applies them to Biketerra routes

(function() {
  'use strict';

  // ============================================================================
  // Turf.js CSP-compatible subset loaded via manifest content_scripts
  // ============================================================================

  // turf-csp.js is loaded before this file and exports to global turf
  function loadTurf() {
    if (typeof turf !== 'undefined') {
      console.log('Turf.js available');
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
    createRouteBuffer(route, bufferMeters) {
      const bufferKilometers = bufferMeters / 1000;
      return turf.buffer(route.turfLineString, bufferKilometers, { units: 'kilometers' });
    },

    // Extract cumulative distances from Biketerra's embedded route data
    // Each coordinate has a 'distance' property with cumulative meters
    calculateCumulativeDistances(routeCoords) {
      return routeCoords.map(coord => coord.distance);
    },

    brunnelWithin(brunnel, routeBuffer) {
      for (const point of brunnel.turfPoints) {
        if (!turf.booleanPointInPolygon(point, routeBuffer)) {
          return false;
        }
      }

      const brunnelLine = brunnel.turfLineString;
      const polygonBoundary = turf.polygonToLine(routeBuffer);
      const intersections = turf.lineIntersect(brunnelLine, polygonBoundary);

      return intersections.features.length === 0;
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

      console.log(`  Turf location: ${turfLocationKm.toFixed(3)}km -> segment ${segmentIndex}, t=${t.toFixed(4)}`);
      console.log(`  Biketerra: ${(dist1/1000).toFixed(3)}km - ${(dist2/1000).toFixed(3)}km -> ${(interpolatedDistance/1000).toFixed(3)}km`);

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

    isWithin(routeBuffer) {
      return GeometryUtils.brunnelWithin(this, routeBuffer);
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
    filterContained(brunnels, routeBuffer) {
      return brunnels.filter(brunnel => {
        const isWithin = brunnel.isWithin(routeBuffer);
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

      console.log(`Fetching route data for ID: ${routeId}`);

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
            console.log(`Found editableRoute index: ${editableRouteIndex}`);
            break;
          }
        }
      }

      if (editableRouteIndex === null) {
        console.log('editableRoute key not found, falling back to simple_route');
        return this.findSimpleRouteInArray(dataArray);
      }

      // Get the editableRoute array (list of indices to point objects)
      const editableRouteIndices = dataArray[editableRouteIndex];
      if (!Array.isArray(editableRouteIndices)) {
        console.log('editableRoute is not an array, falling back to simple_route');
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
        console.log(`Found editableRoute with ${points.length} points`);
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
              console.log(`Found simple_route with ${parsed.length} points`);
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
      await new Promise(r => setTimeout(r, 1));
    },

    // Zoom the chart to a good precision level
    async zoomToPrecision(totalDistanceKm) {
      const chart = this.getElevationChart();
      if (!chart) return;

      // Trigger mouse interaction to ensure labels are up to date
      await this.triggerChartUpdate();

      let visibleRange = this.getChartVisibleRange();
      console.log('Current visible range:', visibleRange);

      // If we're not at full zoom, reset first
      if (visibleRange && visibleRange.rangeKm < totalDistanceKm * 0.9) {
        console.log('Resetting zoom to full view...');
        await this.resetChartZoom(totalDistanceKm);
        await this.triggerChartUpdate();
        visibleRange = this.getChartVisibleRange();
      }

      // Target: 500m visible range for good precision
      const targetRangeKm = 0.5;

      console.log(`Zooming to ${targetRangeKm * 1000}m visible range...`);

      let iterations = 0;
      const maxIterations = 50;

      while (iterations < maxIterations) {
        const rect = chart.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        await this.triggerChartUpdate();
        const currentRange = this.getChartVisibleRange();
        if (!currentRange) break;

        // Check if we've reached target zoom
        if (currentRange.rangeKm <= targetRangeKm) {
          console.log(`Reached target zoom: ${currentRange.rangeKm.toFixed(2)}km range after ${iterations} steps`);
          break;
        }

        // Dispatch wheel event to zoom in
        const wheelEvent = new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: centerX,
          clientY: centerY,
          deltaY: -120,
          deltaMode: 0
        });
        chart.dispatchEvent(wheelEvent);

        await new Promise(r => setTimeout(r, 1));
        iterations++;
      }

      await this.triggerChartUpdate();
      console.log('Final visible range:', this.getChartVisibleRange());
    },

    // Reset chart to full zoom (show entire route)
    async resetChartZoom(totalDistanceKm) {
      const chart = this.getElevationChart();
      if (!chart) return;

      await this.triggerChartUpdate();

      // Zoom out smoothly until we see the full route
      let iterations = 0;
      const maxIterations = 50;

      while (iterations < maxIterations) {
        const rect = chart.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        await this.triggerChartUpdate();
        const visibleRange = this.getChartVisibleRange();

        if (visibleRange && visibleRange.rangeKm >= totalDistanceKm * 0.95) {
          break;
        }

        const wheelEvent = new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: centerX, clientY: centerY,
          deltaY: 120, // Scroll to zoom out
          deltaMode: 0
        });
        chart.dispatchEvent(wheelEvent);
        await new Promise(r => setTimeout(r, 1));
        iterations++;
      }

      await this.triggerChartUpdate();
      console.log('Chart zoom reset');
    },

    // Clear any existing selection
    async clearSelection() {
      const chart = this.getElevationChart();
      if (!chart) return;

      // Remove our debug rectangles
      document.querySelectorAll('.bt-selection-rect').forEach(el => el.remove());

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

      await new Promise(r => setTimeout(r, 1));
      console.log('Selection cleared, chart class:', chart.className);
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
        console.log(`Fallback selection: ${startPx.toFixed(1)}px to ${endPx.toFixed(1)}px`);
        return this._performSelection(chart, rect, startPx, endPx, centerY);
      }

      console.log(`Visible range: ${visibleRange.startKm.toFixed(3)}km - ${visibleRange.endKm.toFixed(3)}km (${visibleRange.rangeKm.toFixed(3)}km, precise: ${visibleRange.precise})`);
      console.log(`Selection target: ${startKm.toFixed(3)}km - ${endKm.toFixed(3)}km (${((endKm - startKm) * 1000).toFixed(0)}m)`);

      // Calculate pixel positions based on visible range
      // Use percentPerKm if available for higher precision
      let startPx, endPx;
      if (visibleRange.percentPerKm) {
        // High precision: use the calculated percent per km
        const startPercent = (startKm - visibleRange.startKm) * visibleRange.percentPerKm;
        const endPercent = (endKm - visibleRange.startKm) * visibleRange.percentPerKm;
        startPx = rect.left + (startPercent / 100) * rect.width;
        endPx = rect.left + (endPercent / 100) * rect.width;
        console.log(`Using precise percentPerKm: ${visibleRange.percentPerKm.toFixed(2)}%/km`);
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

      console.log(`Pixel positions: start=${startPx.toFixed(1)}px, end=${endPx.toFixed(1)}px`);
      console.log(`Selection width: ${pixelWidth.toFixed(1)}px (${metersPerPixel.toFixed(2)}m/px)`);

      // IMPORTANT: First move mouse to start position WITHOUT shift
      // This ensures Svelte's internal cursor position is at our start
      chart.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true, clientX: startPx, clientY: centerY, view: window
      }));
      chart.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: startPx, clientY: centerY, view: window, shiftKey: false
      }));
      await new Promise(r => setTimeout(r, 1));

      // Now press Shift - this should enable selection mode at current cursor position
      window.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: true, view: window
      }));
      await new Promise(r => setTimeout(r, 1));

      console.log('Chart class after shift:', chart.className);

      // Mouse down at start (this anchors the selection start)
      chart.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: window,
        clientX: startPx, clientY: centerY,
        button: 0, buttons: 1, shiftKey: true
      }));
      await new Promise(r => setTimeout(r, 1));

      // Drag to end position - this extends the selection
      const dragSteps = 15;
      for (let i = 1; i <= dragSteps; i++) {
        const x = startPx + (endPx - startPx) * (i / dragSteps);
        chart.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: centerY,
          button: 0, buttons: 1, shiftKey: true
        }));
        await new Promise(r => setTimeout(r, 1));
      }

      console.log('Chart class after drag:', chart.className);

      // Mouse up at end position - this finalizes the selection
      chart.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, view: window,
        clientX: endPx, clientY: centerY,
        button: 0, buttons: 0, shiftKey: true
      }));
      await new Promise(r => setTimeout(r, 1));

      // Keep shift held for a moment, then release
      window.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, key: 'Shift', code: 'ShiftLeft', shiftKey: false, view: window
      }));
      await new Promise(r => setTimeout(r, 1));

      console.log('Chart class after selection:', chart.className);

      // Log button states
      const bridgeBtn = this.getBridgeButton();
      console.log('Bridge button:', bridgeBtn?.className);
    },

    // Click the bridge or tunnel button
    async clickBrunnelButton(type) {
      const button = type === 'bridge' ? this.getBridgeButton() : this.getTunnelButton();
      if (!button) {
        console.error(`${type} button not found`);
        throw new Error(`${type} button not found`);
      }

      console.log(`Clicking ${type} button:`, button);
      console.log(`Button HTML:`, button.outerHTML.slice(0, 200));

      // Find all clickable elements within the button
      const img = button.querySelector('img');
      const icon = button.querySelector('.toolbar-item-icon');

      console.log(`Found img:`, img);
      console.log(`Found icon:`, icon);

      // Try dispatching a proper mouse click event instead of .click()
      const clickTarget = img || icon || button;
      const rect = clickTarget.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      console.log(`Click target:`, clickTarget.tagName, `at (${centerX.toFixed(0)}, ${centerY.toFixed(0)})`);

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
      await new Promise(r => setTimeout(r, 1));
      clickTarget.dispatchEvent(mouseUp);
      await new Promise(r => setTimeout(r, 1));
      clickTarget.dispatchEvent(click);

      // Wait for UI to update
      await new Promise(resolve => setTimeout(resolve, 1));
      console.log(`${type} button click sequence complete`);
    },

    // Apply a single brunnel (assumes chart is already zoomed)
    // If visibleRange is provided, skips chart updates (for batch operations)
    async applyBrunnel(brunnel, totalDistance, visibleRange = null) {
      const startKm = brunnel.startDistance;
      const endKm = brunnel.endDistance;
      const spanMeters = (endKm - startKm) * 1000;

      console.log(`=== Applying ${brunnel.type}: ${brunnel.name} ===`);
      console.log(`  Location: ${startKm.toFixed(3)}km - ${endKm.toFixed(3)}km (${spanMeters.toFixed(0)}m span)`);

      // Make the selection using actual km values (works even if off-screen)
      await this.simulateSelection(startKm, endKm, totalDistance, visibleRange);

      // Click the appropriate button
      await this.clickBrunnelButton(brunnel.type);
    },

    // Apply multiple brunnels with precision zoom
    async applyAllBrunnels(brunnels, totalDistance) {
      if (brunnels.length === 0) return;

      console.log(`Applying ${brunnels.length} brunnels with precision zoom`);

      // Zoom to a good precision level (500m visible range)
      await this.zoomToPrecision(totalDistance);

      // Get visible range once after zooming (reuse for all brunnels)
      await this.triggerChartUpdate();
      const visibleRange = this.getChartVisibleRange();
      console.log('Cached visible range for batch:', visibleRange);

      // Apply each brunnel (selection works even when off-screen)
      for (const brunnel of brunnels) {
        await this.applyBrunnel(brunnel, totalDistance, visibleRange);
      }

      console.log('All brunnels applied');
    }
  };

  // ============================================================================
  // Main Detection Pipeline
  // ============================================================================

  async function detectBrunnels(options = {}) {
    const { queryBuffer = 10, routeBuffer = 3, bearingTolerance = 20 } = options;

    // Load Turf.js
    await loadTurf();

    // Fetch route data from Biketerra API
    const simpleRoute = await BiketerraIntegration.fetchRouteData();
    const route = BiketerraIntegration.parseRouteData(simpleRoute);
    console.log(`Route extracted: ${route.totalDistance.toFixed(2)} km, ${route.coordinates.length} points`);

    // Calculate bounds and query Overpass
    const bounds = GeometryUtils.calculateBounds(route.coordinates);
    const expandedBounds = GeometryUtils.expandBounds(bounds, queryBuffer);

    console.log('Querying Overpass API...');
    const overpassData = await OverpassAPI.queryBrunnels(expandedBounds);
    console.log(`Found ${overpassData.bridges.length} bridges, ${overpassData.tunnels.length} tunnels from Overpass`);

    // Create Brunnel instances
    const brunnels = Brunnel.fromOverpassData(overpassData);

    // Filter by containment
    const routeBufferGeom = GeometryUtils.createRouteBuffer(route, routeBuffer);
    BrunnelAnalysis.filterContained(brunnels, routeBufferGeom);

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

    console.log(`Final result: ${includedBrunnels.length} brunnels`);

    // Return simplified data for popup
    return {
      brunnels: includedBrunnels.map(b => ({
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
    if (message.action === 'detectBrunnels') {
      detectBrunnels(message.options)
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
          await BiketerraIntegration.applyBrunnel(message.brunnel, route.totalDistance);
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
          await BiketerraIntegration.applyAllBrunnels(message.brunnels, route.totalDistance);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ error: error.message });
        }
      })();
      return true;
    }

    if (message.action === 'highlightBrunnel') {
      // Visual highlight on elevation chart (optional preview)
      const chart = BiketerraIntegration.getElevationChart();
      if (chart) {
        const startX = message.brunnel.startDistance / message.totalDistance;
        const endX = message.brunnel.endDistance / message.totalDistance;

        // Remove existing highlights
        document.querySelectorAll('.bt-elevation-highlight').forEach(el => el.remove());

        // Add highlight
        const highlight = document.createElement('div');
        highlight.className = `bt-elevation-highlight ${message.brunnel.type}`;
        highlight.style.left = `${startX * 100}%`;
        highlight.style.width = `${(endX - startX) * 100}%`;
        chart.style.position = 'relative';
        chart.appendChild(highlight);

        // Remove after 2 seconds
        setTimeout(() => highlight.remove(), 2000);
      }
      sendResponse({ success: true });
      return true;
    }
  });

  console.log('Biketerra Brunnels extension loaded');
})();
