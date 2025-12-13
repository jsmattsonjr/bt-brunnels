// Popup script for Biketerra Brunnels extension

const BRIDGE_ICON = `<svg class="brunnel-icon" viewBox="0 0 147 71" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M74.5 5C39 5 35.5 24.5 5 24.5V66H19H33C36 41 46 24.5 74.5 24.5C101.5 24.5 111 40 116 66H142V24.5C111 24.5 108 5 74.5 5Z" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const TUNNEL_ICON = `<svg class="brunnel-icon" viewBox="0 0 118 87" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M58.5 5.21033H5V81.7103H35C30.5 73.5 26.5 66 26.5 53.2103C26.5 34 42.5 20 60 20C77.5 20 92.5 33.5 92.5 53.2103C92.5 66 89.5 74.5 83 81.7103H112.5V5.21033H58.5Z" stroke-width="10" stroke-linejoin="round"/>
</svg>`;

let locatedBrunnels = [];

document.addEventListener('DOMContentLoaded', () => {
  const locateBtn = document.getElementById('locateBtn');
  const applyBtn = document.getElementById('applyBtn');
  const statusDiv = document.getElementById('status');
  const resultsDiv = document.getElementById('results');
  const progressDiv = document.getElementById('progress');

  locateBtn.addEventListener('click', locateBrunnels);
  applyBtn.addEventListener('click', applyAllBrunnels);

  // Listen for progress updates from content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress') {
      progressDiv.textContent = message.text;
    }
  });

  // Check if we're on a Biketerra editor page
  checkBiketerraPage();
});

async function checkBiketerraPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusDiv = document.getElementById('status');
  const locateBtn = document.getElementById('locateBtn');

  if (!tab.url || !tab.url.includes('biketerra.com/routes/new')) {
    statusDiv.textContent = 'Please open a route in the Biketerra editor.';
    statusDiv.className = 'status error';
    locateBtn.disabled = true;
  }
}

async function locateBrunnels() {
  const statusDiv = document.getElementById('status');
  const progressDiv = document.getElementById('progress');
  const locateBtn = document.getElementById('locateBtn');

  const queryBuffer = parseInt(document.getElementById('queryBuffer').value) || 10;
  const routeBuffer = parseInt(document.getElementById('routeBuffer').value) || 3;
  const bearingTolerance = parseInt(document.getElementById('bearingTolerance').value) || 20;

  statusDiv.textContent = 'Locating brunnels...';
  statusDiv.className = 'status';
  progressDiv.style.display = 'block';
  progressDiv.textContent = 'Extracting route data...';
  locateBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Send message to content script to locate brunnels
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'locateBrunnels',
      options: { queryBuffer, routeBuffer, bearingTolerance }
    });

    if (response.error) {
      throw new Error(response.error);
    }

    locatedBrunnels = response.brunnels;
    displayResults(locatedBrunnels, response.totalDistance);

    statusDiv.textContent = `Found ${locatedBrunnels.length} brunnel(s)`;
    statusDiv.className = 'status success';
    document.getElementById('applyBtn').disabled = locatedBrunnels.length === 0;
    // Keep detect button disabled after successful detection
    progressDiv.style.display = 'none';
  } catch (error) {
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = 'status error';
    progressDiv.style.display = 'none';
    locateBtn.disabled = false;
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

    const icon = brunnel.type === 'bridge' ? BRIDGE_ICON : TUNNEL_ICON;
    item.innerHTML = `
      ${icon}
      <div class="brunnel-info">
        <div class="brunnel-name">${brunnel.name}</div>
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

  if (locatedBrunnels.length === 0) return;

  statusDiv.textContent = 'Applying brunnels...';
  statusDiv.className = 'status';
  progressDiv.style.display = 'block';
  progressDiv.textContent = `Applying ${locatedBrunnels.length} brunnels with precision zoom...`;
  applyBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Sort by start distance
    const sorted = [...locatedBrunnels].sort((a, b) => a.startDistance - b.startDistance);

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
    // Keep apply button disabled after successful application
    progressDiv.style.display = 'none';
  } catch (error) {
    statusDiv.textContent = `Error: ${error.message}`;
    statusDiv.className = 'status error';
    progressDiv.style.display = 'none';
    applyBtn.disabled = false;
  }
}
