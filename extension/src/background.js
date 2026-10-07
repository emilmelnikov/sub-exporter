// Keep exports in a full extension tab so closing a popup or suspending the
// service worker cannot interrupt pagination.
chrome.action.onClicked.addListener((tab) => {
  const url = new URL(chrome.runtime.getURL("export.html"));
  if (tab.id != null) url.searchParams.set("tab", String(tab.id));
  chrome.tabs.create({ url: url.href });
});
