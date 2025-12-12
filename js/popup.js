// Popup script for Biketerra Brunnels extension

let detectedBrunnels = [];

document.addEventListener('DOMContentLoaded', () => {
  const detectBtn = document.getElementById('detectBtn');
  const applyBtn = document.getElementById('applyBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const progressDiv = document.getElementById('progress');

  detectBtn.addEventListener('click', detectBrunnels);
  applyBtn.addEventListener('click', applyAllBrunnels);
  clearBtn.addEventListener('click', clearResults);

  // Check if we're on a Biketerra editor page
  checkBiketerraPage();
});

async function checkBiketerraPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusDiv = document.getElementById('status');
  const detectBtn = document.getElementById('detectBtn');

  if (!tab.url || !tab.url.includes('biketerra.com/routes/new')) {
    statusDiv.textContent = 'Please open a route in the Biketerra editor.';
    statusDiv.className = 'status error';
    detectBtn.disabled = true;
  }
}

async function detectBrunnels() {
  const statusDiv = document.getElementById('status');
  const progressDiv = document.getElementById('progress');
  const detectBtn = document.getElementById('detectBtn');

  const queryBuffer = parseInt(document.getElementById('queryBuffer').value) || 10;
  const routeBuffer = parseInt(document.getElementById('routeBuffer').value) || 3;
  const bearingTolerance = parseInt(document.getElementById('bearingTolerance').value) || 20;

  statusDiv.textContent = 'Detecting brunnels...';
  statusDiv.className = 'status';
  progressDiv.style.display = 'block';
  progressDiv.textContent = 'Extracting route data...';
  detectBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Send message to content script to detect brunnels
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'detectBrunnels',
      options: { queryBuffer, routeBuffer, bearingTolerance }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    detectedBrunnels = response.brunnels;
    displayResults(detectedBrunnels, response.totalDistance);

    statusDiv.textContent = `Found ${detectedBrunnels.length} brunnel(s)`;
    statusDiv.className = 'status success';
    document.getElementById('applyBtn').disabled = detectedBrunnels.length === 0;
  } catch (error) {
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = 'status error';
  } finally {
    progressDiv.style.display = 'none';
    detectBtn.disabled = false;
  }
}

function displayResults(brunnels, totalDistance) {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '';

  if (brunnels.length === 0) {
    resultsDiv.innerHTML = '<p class="empty-message">No brunnels found on this route.</p>';
    return;
  }

  // Sort by start distance
  const sorted = [...brunnels].sort((a, b) => a.startDistance - b.startDistance);

  for (const brunnel of sorted) {
    const item = document.createElement('div');
    item.className = `brunnel-item ${brunnel.type}`;
    item.dataset.id = brunnel.id;

    const startKm = (brunnel.startDistance).toFixed(2);
    const endKm = (brunnel.endDistance).toFixed(2);
    const lengthM = ((brunnel.endDistance - brunnel.startDistance) * 1000).toFixed(0);

    item.innerHTML = `
      <div>
        <div class="brunnel-name">${brunnel.type === 'bridge' ? '🌉' : '🚇'} ${brunnel.name}</div>
        <div class="brunnel-span">${startKm} - ${endKm} km (${lengthM}m)</div>
      </div>
    `;

    item.addEventListener('click', () => highlightBrunnel(brunnel, totalDistance));
    resultsDiv.appendChild(item);
  }
}

async function highlightBrunnel(brunnel, totalDistance) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.tabs.sendMessage(tab.id, {
    action: 'highlightBrunnel',
    brunnel,
    totalDistance
  });
}

async function applyAllBrunnels() {
  const statusDiv = document.getElementById('status');
  const progressDiv = document.getElementById('progress');
  const applyBtn = document.getElementById('applyBtn');

  if (detectedBrunnels.length === 0) return;

  statusDiv.textContent = 'Applying brunnels...';
  statusDiv.className = 'status';
  progressDiv.style.display = 'block';
  progressDiv.textContent = `Applying ${detectedBrunnels.length} brunnels with precision zoom...`;
  applyBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Sort by start distance
    const sorted = [...detectedBrunnels].sort((a, b) => a.startDistance - b.startDistance);

    // Apply all brunnels in one operation (zoom once, apply all, zoom out)
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'applyAllBrunnels',
      brunnels: sorted
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Mark all as applied in UI
    for (const brunnel of sorted) {
      const item = document.querySelector(`.brunnel-item[data-id="${brunnel.id}"]`);
      if (item) item.classList.add('applied');
    }

    statusDiv.textContent = `Applied ${sorted.length} brunnel(s) successfully!`;
    statusDiv.className = 'status success';
  } catch (error) {
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = 'status error';
  } finally {
    progressDiv.style.display = 'none';
    applyBtn.disabled = false;
  }
}

function clearResults() {
  detectedBrunnels = [];
  document.getElementById('results').innerHTML = '';
  document.getElementById('status').textContent = 'Ready. Open a route in the Biketerra editor.';
  document.getElementById('status').className = 'status';
  document.getElementById('applyBtn').disabled = true;
}
