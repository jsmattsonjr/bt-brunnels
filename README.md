# Biketerra Brunnels Extension

A Chrome extension that automatically detects bridges and tunnels from OpenStreetMap and applies them to routes in the Biketerra editor.

## Features

- Extracts route data from Biketerra editor pages
- Queries OpenStreetMap via Overpass API for bridges and tunnels along the route
- Filters brunnels by:
  - Containment within route buffer
  - Bearing alignment with route
  - Overlap resolution (keeps closest to route)
- Simulates UI interactions to apply brunnels to the elevation graph
- Visual preview highlighting on the elevation chart

## Installation

1. **Create icons**: Before loading the extension, you need to create icon files. Create PNG images at these sizes and place them in the `icons/` folder:
   - `icon16.png` (16x16 pixels)
   - `icon48.png` (48x48 pixels)
   - `icon128.png` (128x128 pixels)

   Or use ImageMagick:
   ```bash
   cd icons && ./generate-icons.sh
   ```

2. **Load the extension in Chrome**:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `biketerra-brunnels-extension` folder

3. **Pin the extension** (optional): Click the puzzle piece icon in Chrome's toolbar and pin "Biketerra Brunnels" for easy access.

## Usage

1. Open a route in the Biketerra editor (`https://www.biketerra.com/editor/...`)
2. Click the extension icon in Chrome's toolbar
3. Adjust options if needed:
   - **Query buffer**: Search radius around route for Overpass API (default: 10m)
   - **Route buffer**: Containment tolerance for filtering (default: 3m)
   - **Bearing tolerance**: Alignment tolerance in degrees (default: 20°)
4. Click **"Detect Brunnels"**
5. Review the detected bridges and tunnels in the list
6. Click individual items to preview their location on the elevation chart
7. Click **"Apply All to Route"** to add them to Biketerra

## How It Works

### Route Extraction
The extension reads route data from Biketerra's SvelteKit data structure, extracting the `simple_route` array which contains `[lat, lon, elevation, cumulative_distance]` for each trackpoint.

### Brunnel Detection
Uses the Overpass API to query OpenStreetMap for bridges and tunnels within a bounding box around the route, excluding:
- Waterways
- Ways marked `bicycle=no`
- Active railway infrastructure

### Filtering Pipeline
1. **Containment**: Only brunnels fully within the buffered route geometry
2. **Route span calculation**: Projects brunnel endpoints onto the route
3. **Alignment**: Filters by bearing alignment between brunnel and route segment
4. **Overlap resolution**: When multiple brunnels cover the same route segment, keeps the one closest to the route

### UI Automation
Simulates the native Biketerra workflow:
1. Converts brunnel distances to x-coordinates on the elevation chart
2. Dispatches shift+mousedown, mousemove, mouseup events to select the region
3. Clicks the bridge or tunnel toolbar button

## Troubleshooting

### "Could not extract route data"
- Make sure a route is fully loaded in the editor
- Try refreshing the page and waiting for it to fully load

### Brunnels not being applied
- The extension relies on Biketerra's UI elements. If the UI has changed, the selectors may need updating.
- Check the browser console for error messages.

### Rate limiting from Overpass API
- The extension queries the public Overpass API which has rate limits
- Wait a few minutes between queries for long routes
- Consider running the brunnels-js proxy server locally for caching

## Development

### File Structure
```
biketerra-brunnels-extension/
├── manifest.json          # Extension manifest (MV3)
├── popup.html             # Extension popup UI
├── css/
│   └── content.css        # Styles for injected UI elements
├── js/
│   ├── popup.js           # Popup script
│   └── content.js         # Content script with brunnel detection
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Debugging
- Open Chrome DevTools on the Biketerra page to see content script logs
- Right-click the extension icon → "Inspect popup" to debug the popup

## Credits

Based on the [brunnels-js](../brunnels-js/) project which provides the core brunnel detection algorithms.

## License

MIT License
