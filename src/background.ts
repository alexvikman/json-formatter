// Keep the service worker independent of the renderer's DOM-only globals.
declare const chrome: {
  action: { onClicked: { addListener(listener: () => void): void } };
  runtime: { getURL(path: string): string };
  tabs: { create(options: { url: string; active: boolean }): Promise<unknown> };
};

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({
    url: chrome.runtime.getURL("formatter.html"),
    active: true
  }).catch((error: unknown) => {
    console.error("Could not open JSON Formatter.", error);
  });
});

export {};
