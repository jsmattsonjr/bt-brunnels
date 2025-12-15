// Biketerra Brunnels Extension - Background Service Worker
// Handles extension icon click to toggle the overlay panel

chrome.action.onClicked.addListener(async (tab) => {
  // Only work on Biketerra editor pages
  if (!tab.url || !tab.url.includes('biketerra.com/routes/new')) {
    // Show a notification or badge indicating wrong page
    chrome.action.setBadgeText({ text: '!', tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#e53e3e', tabId: tab.id });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId: tab.id });
    }, 2000);
    return;
  }

  // Send toggle message to content script
  try {
    await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
  } catch (error) {
    // Content script might not be loaded yet, try injecting it
    console.log('Content script not ready, trying to inject...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['js/turf-csp.js', 'js/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['css/content.css']
      });
      // Try sending the message again
      await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' });
    } catch (injectError) {
      console.error('Failed to inject content script:', injectError);
    }
  }
});
