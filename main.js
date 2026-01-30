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

// Delete a specific line
function deleteLine(lineId) {
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
  lines.set(lineId, {
    polyline: layer,
    labels: [],
    color: color,
    number: lineCounter
  });

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

// Airport quick jump buttons
document.getElementById('airports').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    const lat = parseFloat(e.target.dataset.lat);
    const lng = parseFloat(e.target.dataset.lng);
    const zoom = parseInt(e.target.dataset.zoom);
    map.setView([lat, lng], zoom);
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

// Right-click to start a new line
let currentDrawHandler = null;
map.on('contextmenu', (e) => {
  // Cancel any existing draw operation
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
