import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';

// Fix Leaflet default marker icon issue with bundlers
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Walking speed: 3 feet per second
const WALKING_SPEED_FT_PER_SEC = 3;
const METERS_TO_FEET = 3.28084;

// Line colors for visual distinction
const LINE_COLORS = ['#3388ff', '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#ffeaa7', '#dfe6e9', '#fd79a8'];
let lineCounter = 0;

// Store lines with their labels
const lines = new Map(); // lineId -> { polyline, labels: [] }

// Undo stack (max 10 actions)
const undoStack = [];
const MAX_UNDO = 10;

function pushUndo(action) {
  undoStack.push(action);
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }
}

// Initialize the map centered on ATL (busiest airport)
const map = L.map('map').setView([33.6407, -84.4277], 17);

// Add OpenStreetMap tiles (shows terminal/gate detail at high zoom)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// Feature group to store drawn items
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

// Feature group for labels (separate so they stay on top)
const labelsLayer = new L.FeatureGroup();
map.addLayer(labelsLayer);

// Initialize draw control
const drawControl = new L.Control.Draw({
  position: 'topleft',
  draw: {
    polygon: false,
    rectangle: false,
    circle: false,
    circlemarker: false,
    marker: false,
    polyline: {
      shapeOptions: {
        color: '#3388ff',
        weight: 4,
        opacity: 0.8
      },
      metric: false,
      feet: true
    }
  },
  edit: {
    featureGroup: drawnItems,
    remove: true
  }
});
map.addControl(drawControl);

// Calculate total distance of a polyline in feet
function calculateDistance(latlngs) {
  let totalMeters = 0;
  for (let i = 0; i < latlngs.length - 1; i++) {
    totalMeters += latlngs[i].distanceTo(latlngs[i + 1]);
  }
  return totalMeters * METERS_TO_FEET;
}

// Format time from seconds to readable string (rounded to nearest minute)
function formatTime(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins === 0) {
    return '<1m';
  } else {
    return `${mins}m`;
  }
}

// Format time for display (longer format, rounded to nearest minute)
function formatTimeLong(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins === 0) {
    return '<1 min';
  } else if (mins === 1) {
    return '1 min';
  } else {
    return `${mins} min`;
  }
}

// Get midpoint of a polyline for label placement
function getMidpoint(latlngs) {
  if (latlngs.length === 0) return null;
  if (latlngs.length === 1) return latlngs[0];

  // Calculate total length and find midpoint
  let totalLength = 0;
  const segments = [];
  for (let i = 0; i < latlngs.length - 1; i++) {
    const segLength = latlngs[i].distanceTo(latlngs[i + 1]);
    segments.push({ start: latlngs[i], end: latlngs[i + 1], length: segLength });
    totalLength += segLength;
  }

  const midDistance = totalLength / 2;
  let accumulated = 0;
  for (const seg of segments) {
    if (accumulated + seg.length >= midDistance) {
      const ratio = (midDistance - accumulated) / seg.length;
      return L.latLng(
        seg.start.lat + (seg.end.lat - seg.start.lat) * ratio,
        seg.start.lng + (seg.end.lng - seg.start.lng) * ratio
      );
    }
    accumulated += seg.length;
  }
  return latlngs[Math.floor(latlngs.length / 2)];
}

// Create a label marker for a segment
function createSegmentLabel(latlng, text, color) {
  const icon = L.divIcon({
    className: 'line-label',
    html: `<div style="background: ${color}; border: 2px solid white; color: white; padding: 3px 6px; border-radius: 3px; font-weight: bold; font-size: 11px; white-space: nowrap; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${text}</div>`,
    iconSize: null,
    iconAnchor: [0, 0]
  });
  return L.marker(latlng, { icon, interactive: false });
}

// Create a total label marker (larger, at end of line)
function createTotalLabel(latlng, text, color) {
  const icon = L.divIcon({
    className: 'line-label total-label',
    html: `<div style="background: ${color}; border: 3px solid white; color: white; padding: 5px 10px; border-radius: 5px; font-weight: bold; font-size: 13px; white-space: nowrap; box-shadow: 0 3px 6px rgba(0,0,0,0.4);">Total: ${text}</div>`,
    iconSize: null,
    iconAnchor: [0, 0]
  });
  return L.marker(latlng, { icon, interactive: false });
}

// Get midpoint between two latlngs
function getSegmentMidpoint(start, end) {
  return L.latLng(
    (start.lat + end.lat) / 2,
    (start.lng + end.lng) / 2
  );
}

// Update labels for a specific line (per-segment + total)
function updateLineLabel(lineId) {
  const lineData = lines.get(lineId);
  if (!lineData) return;

  // Remove old labels
  if (lineData.labels) {
    lineData.labels.forEach(label => labelsLayer.removeLayer(label));
  }
  lineData.labels = [];

  let latlngs = lineData.polyline.getLatLngs();
  // Leaflet can return nested arrays for polylines - flatten if needed
  if (latlngs.length > 0 && Array.isArray(latlngs[0])) {
    latlngs = latlngs[0];
  }
  if (latlngs.length < 2) return;

  let totalFeet = 0;

  // Create label for each segment
  for (let i = 0; i < latlngs.length - 1; i++) {
    const segmentMeters = latlngs[i].distanceTo(latlngs[i + 1]);
    const segmentFeet = segmentMeters * METERS_TO_FEET;
    totalFeet += segmentFeet;
    const segmentSeconds = segmentFeet / WALKING_SPEED_FT_PER_SEC;

    const midpoint = getSegmentMidpoint(latlngs[i], latlngs[i + 1]);
    const label = createSegmentLabel(midpoint, formatTime(segmentSeconds), lineData.color);
    lineData.labels.push(label);
    labelsLayer.addLayer(label);
  }

  // Create total label at the end of the line
  const totalSeconds = totalFeet / WALKING_SPEED_FT_PER_SEC;
  const endPoint = latlngs[latlngs.length - 1];
  const totalLabel = createTotalLabel(endPoint, formatTime(totalSeconds), lineData.color);
  lineData.labels.push(totalLabel);
  labelsLayer.addLayer(totalLabel);
}

// Update the sidebar list
function updateLinesList() {
  const listEl = document.getElementById('lines-list');

  if (lines.size === 0) {
    listEl.innerHTML = '<p class="no-lines">No lines drawn yet</p>';
  } else {
    let html = '';
    lines.forEach((lineData, lineId) => {
      const latlngs = lineData.polyline.getLatLngs();
      const feet = calculateDistance(latlngs);
      const seconds = feet / WALKING_SPEED_FT_PER_SEC;

      html += `
        <div class="line-item" data-line-id="${lineId}">
          <div class="line-color" style="background: ${lineData.color}"></div>
          <div class="line-info">
            <span class="line-name">Line ${lineData.number}</span>
            <span class="line-stats">${Math.round(feet).toLocaleString()} ft · ${formatTimeLong(seconds)}</span>
          </div>
          <button class="delete-line-btn" data-line-id="${lineId}" title="Delete line">×</button>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }
}

// Update totals display
function updateTotals() {
  let totalFeet = 0;

  lines.forEach((lineData) => {
    totalFeet += calculateDistance(lineData.polyline.getLatLngs());
  });

  const distanceEl = document.getElementById('distance-value');
  const timeEl = document.getElementById('time-value');

  if (totalFeet > 0) {
    const walkingTimeSeconds = totalFeet / WALKING_SPEED_FT_PER_SEC;
    distanceEl.textContent = `${Math.round(totalFeet).toLocaleString()} ft (${(totalFeet / 5280).toFixed(2)} mi)`;
    timeEl.textContent = formatTimeLong(walkingTimeSeconds);
  } else {
    distanceEl.textContent = '--';
    timeEl.textContent = '--';
  }
}

// Full update
function updateResults() {
  updateLinesList();
  updateTotals();
}

// Delete a specific line (internal, no undo tracking)
function removeLineFromMap(lineId) {
  const lineData = lines.get(lineId);
  if (lineData) {
    drawnItems.removeLayer(lineData.polyline);
    if (lineData.labels) {
      lineData.labels.forEach(label => labelsLayer.removeLayer(label));
    }
    lines.delete(lineId);
    updateResults();
  }
}

// Delete a specific line (user action, with undo)
function deleteLine(lineId) {
  const lineData = lines.get(lineId);
  if (lineData) {
    // Save data for undo
    const latlngs = lineData.polyline.getLatLngs();
    pushUndo({
      type: 'delete',
      lineId,
      latlngs: Array.isArray(latlngs[0]) ? latlngs[0] : latlngs,
      color: lineData.color,
      number: lineData.number
    });
    removeLineFromMap(lineId);
  }
}

// Handle draw created event
map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  lineCounter++;
  const lineId = `line-${lineCounter}`;
  const color = LINE_COLORS[(lineCounter - 1) % LINE_COLORS.length];

  // Set the line color
  layer.setStyle({ color, weight: 4, opacity: 0.8 });
  layer._lineId = lineId;

  drawnItems.addLayer(layer);

  // Store line data
  const lineData = {
    polyline: layer,
    labels: [],
    color: color,
    number: lineCounter
  };
  lines.set(lineId, lineData);

  // Push to undo stack
  pushUndo({ type: 'create', lineId });

  // Create label
  updateLineLabel(lineId);
  updateResults();
});

// Handle edit events - update labels after editing
map.on(L.Draw.Event.EDITED, (e) => {
  e.layers.eachLayer((layer) => {
    if (layer._lineId) {
      updateLineLabel(layer._lineId);
    }
  });
  updateResults();
});

// Handle delete from map control
map.on(L.Draw.Event.DELETED, (e) => {
  e.layers.eachLayer((layer) => {
    if (layer._lineId) {
      const lineData = lines.get(layer._lineId);
      if (lineData && lineData.labels) {
        lineData.labels.forEach(label => labelsLayer.removeLayer(label));
      }
      lines.delete(layer._lineId);
    }
  });
  updateResults();
});

// Handle click on delete buttons in sidebar
document.getElementById('lines-list').addEventListener('click', (e) => {
  if (e.target.classList.contains('delete-line-btn')) {
    const lineId = e.target.dataset.lineId;
    deleteLine(lineId);
  }
});

// Airport data
const airports = [
  { code: 'ATL', name: 'Atlanta', lat: 33.6407, lng: -84.4277 },
  { code: 'AUS', name: 'Austin', lat: 30.1975, lng: -97.6664 },
  { code: 'BDL', name: 'Hartford/Windsor Locks', lat: 41.9389, lng: -72.6860 },
  { code: 'BHM', name: 'Birmingham', lat: 33.5629, lng: -86.7535 },
  { code: 'BNA', name: 'Nashville', lat: 36.1263, lng: -86.6774 },
  { code: 'BOI', name: 'Boise', lat: 43.5644, lng: -116.2228 },
  { code: 'BOS', name: 'Boston', lat: 42.3656, lng: -71.0096 },
  { code: 'BUF', name: 'Buffalo', lat: 42.9405, lng: -78.7322 },
  { code: 'BWI', name: 'Baltimore', lat: 39.1754, lng: -76.6683 },
  { code: 'CLE', name: 'Cleveland', lat: 41.4117, lng: -81.8498 },
  { code: 'CMH', name: 'Columbus', lat: 39.9980, lng: -82.8919 },
  { code: 'CVG', name: 'Cincinnati', lat: 39.0488, lng: -84.6678 },
  { code: 'DAL', name: 'Dallas Love Field', lat: 32.8471, lng: -96.8518 },
  { code: 'DCA', name: 'Washington Reagan', lat: 38.8512, lng: -77.0402 },
  { code: 'DEN', name: 'Denver', lat: 39.8561, lng: -104.6737 },
  { code: 'DFW', name: 'Dallas/Fort Worth', lat: 32.8998, lng: -97.0403 },
  { code: 'DTW', name: 'Detroit', lat: 42.2124, lng: -83.3534 },
  { code: 'EWR', name: 'Newark', lat: 40.6895, lng: -74.1745 },
  { code: 'FLL', name: 'Fort Lauderdale', lat: 26.0726, lng: -80.1527 },
  { code: 'GSP', name: 'Greenville-Spartanburg', lat: 34.8957, lng: -82.2189 },
  { code: 'HNL', name: 'Honolulu', lat: 21.3187, lng: -157.9225 },
  { code: 'HOU', name: 'Houston Hobby', lat: 29.6454, lng: -95.2789 },
  { code: 'HPN', name: 'Westchester County', lat: 41.0670, lng: -73.7076 },
  { code: 'IAD', name: 'Washington Dulles', lat: 38.9531, lng: -77.4565 },
  { code: 'IAH', name: 'Houston Bush', lat: 29.9902, lng: -95.3368 },
  { code: 'JFK', name: 'New York JFK', lat: 40.6413, lng: -73.7781 },
  { code: 'LAS', name: 'Las Vegas', lat: 36.0840, lng: -115.1537 },
  { code: 'LAX', name: 'Los Angeles', lat: 33.9425, lng: -118.4081 },
  { code: 'LGA', name: 'New York LaGuardia', lat: 40.7769, lng: -73.8740 },
  { code: 'LGB', name: 'Long Beach', lat: 33.8177, lng: -118.1516 },
  { code: 'MCI', name: 'Kansas City', lat: 39.2976, lng: -94.7139 },
  { code: 'MCO', name: 'Orlando', lat: 28.4312, lng: -81.3081 },
  { code: 'MDW', name: 'Chicago Midway', lat: 41.7868, lng: -87.7522 },
  { code: 'MIA', name: 'Miami', lat: 25.7959, lng: -80.2870 },
  { code: 'MKE', name: 'Milwaukee', lat: 42.9472, lng: -87.8966 },
  { code: 'MSP', name: 'Minneapolis-St. Paul', lat: 44.8848, lng: -93.2223 },
  { code: 'MSY', name: 'New Orleans', lat: 29.9934, lng: -90.2580 },
  { code: 'OAK', name: 'Oakland', lat: 37.7126, lng: -122.2197 },
  { code: 'OGG', name: 'Maui', lat: 20.8986, lng: -156.4305 },
  { code: 'OKC', name: 'Oklahoma City', lat: 35.3931, lng: -97.6007 },
  { code: 'ONT', name: 'Ontario', lat: 34.0560, lng: -117.6012 },
  { code: 'ORD', name: 'Chicago O\'Hare', lat: 41.9742, lng: -87.9073 },
  { code: 'PBI', name: 'Palm Beach', lat: 26.6832, lng: -80.0956 },
  { code: 'PDX', name: 'Portland', lat: 45.5898, lng: -122.5951 },
  { code: 'PHX', name: 'Phoenix', lat: 33.4373, lng: -112.0078 },
  { code: 'PIT', name: 'Pittsburgh', lat: 40.4915, lng: -80.2329 },
  { code: 'PSP', name: 'Palm Springs', lat: 33.8303, lng: -116.5067 },
  { code: 'PVD', name: 'Providence', lat: 41.7241, lng: -71.4283 },
  { code: 'RDU', name: 'Raleigh-Durham', lat: 35.8801, lng: -78.7880 },
  { code: 'SAN', name: 'San Diego', lat: 32.7336, lng: -117.1897 },
  { code: 'SAT', name: 'San Antonio', lat: 29.5337, lng: -98.4698 },
  { code: 'SEA', name: 'Seattle', lat: 47.4502, lng: -122.3088 },
  { code: 'SFO', name: 'San Francisco', lat: 37.6213, lng: -122.3790 },
  { code: 'SJC', name: 'San Jose', lat: 37.3639, lng: -121.9289 },
  { code: 'SJU', name: 'San Juan', lat: 18.4394, lng: -66.0018 },
  { code: 'SLC', name: 'Salt Lake City', lat: 40.7899, lng: -111.9791 },
  { code: 'SMF', name: 'Sacramento', lat: 38.6954, lng: -121.5910 },
  { code: 'SNA', name: 'Orange County', lat: 33.6757, lng: -117.8678 },
  { code: 'STL', name: 'St. Louis', lat: 38.7487, lng: -90.3700 },
  { code: 'TUL', name: 'Tulsa', lat: 36.1984, lng: -95.8881 }
];

// Render airport list
function renderAirports(filter = '') {
  const listEl = document.getElementById('airport-list');
  const filtered = airports.filter(a =>
    a.code.toLowerCase().includes(filter.toLowerCase()) ||
    a.name.toLowerCase().includes(filter.toLowerCase())
  );

  listEl.innerHTML = filtered.map(a =>
    `<button data-lat="${a.lat}" data-lng="${a.lng}">${a.code} - ${a.name}</button>`
  ).join('');
}

// Initial render
renderAirports();

// Search handler
document.getElementById('airport-search').addEventListener('input', (e) => {
  renderAirports(e.target.value);
});

// Airport click handler
document.getElementById('airport-list').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    const lat = parseFloat(e.target.dataset.lat);
    const lng = parseFloat(e.target.dataset.lng);
    map.setView([lat, lng], 17);
  }
});

// Clear all button
document.getElementById('clear-btn').addEventListener('click', () => {
  drawnItems.clearLayers();
  labelsLayer.clearLayers();
  lines.clear();
  updateResults();
});

// Add scale control
L.control.scale({ imperial: true, metric: true }).addTo(map);

// Right-click to start a new line or finish current line
let currentDrawHandler = null;
map.on('contextmenu', (e) => {
  // If currently drawing, add final point and finish the line
  if (currentDrawHandler && currentDrawHandler._markers && currentDrawHandler._markers.length >= 1) {
    currentDrawHandler.addVertex(e.latlng);
    currentDrawHandler.completeShape();
    return;
  }

  // Cancel any incomplete draw operation (less than 2 points)
  if (currentDrawHandler) {
    currentDrawHandler.disable();
  }

  // Start new polyline draw at the clicked location
  currentDrawHandler = new L.Draw.Polyline(map, {
    shapeOptions: {
      color: LINE_COLORS[lineCounter % LINE_COLORS.length],
      weight: 4,
      opacity: 0.8
    }
  });
  currentDrawHandler.enable();

  // Simulate a click at the right-click location to start the line there
  setTimeout(() => {
    currentDrawHandler.addVertex(e.latlng);
  }, 10);
});

// Clear draw handler reference when drawing completes
map.on(L.Draw.Event.CREATED, () => {
  currentDrawHandler = null;
});

// Restore a deleted line
function restoreLine(latlngs, color, number) {
  const lineId = `line-${number}`;
  const layer = L.polyline(latlngs, { color, weight: 4, opacity: 0.8 });
  layer._lineId = lineId;
  drawnItems.addLayer(layer);

  lines.set(lineId, {
    polyline: layer,
    labels: [],
    color: color,
    number: number
  });

  updateLineLabel(lineId);
  updateResults();
  return lineId;
}

// Undo handler (Ctrl+Z)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (undoStack.length === 0) return;

    const action = undoStack.pop();
    if (action.type === 'create') {
      // Undo create = delete the line (without adding to undo)
      removeLineFromMap(action.lineId);
    } else if (action.type === 'delete') {
      // Undo delete = restore the line
      restoreLine(action.latlngs, action.color, action.number);
    }
  }
});
