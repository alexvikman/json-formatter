(function initJsonFormatterTheme(globalScope: Window & typeof globalThis) {
  "use strict";

  const STORAGE_KEY = "theme";
  const DEFAULT_PREFERENCE: ThemePreference = "system";
  const VALID_PREFERENCES = new Set<ThemePreference>(["system", "light", "dark"]);
  const mediaQuery = typeof globalScope.matchMedia === "function"
    ? globalScope.matchMedia("(prefers-color-scheme: dark)")
    : null;

  function normalizePreference(preference: unknown): ThemePreference {
    return typeof preference === "string" && VALID_PREFERENCES.has(preference as ThemePreference)
      ? preference as ThemePreference
      : DEFAULT_PREFERENCE;
  }

  function resolveTheme(preference: ThemePreference): ResolvedTheme {
    const normalized = normalizePreference(preference);
    if (normalized === "system") {
      return mediaQuery && mediaQuery.matches ? "dark" : "light";
    }
    return normalized;
  }

  function applyPreference(element: HTMLElement, preference: ThemePreference): void {
    const normalized = normalizePreference(preference);
    element.dataset.jfThemePreference = normalized;
    element.dataset.jfTheme = resolveTheme(normalized);
  }

  function getStorageArea(): ChromeStorageArea | null {
    return globalScope.chrome &&
      globalScope.chrome.storage &&
      globalScope.chrome.storage.sync
      ? globalScope.chrome.storage.sync
      : null;
  }

  function getPreference(): Promise<ThemePreference> {
    const storageArea = getStorageArea();
    if (!storageArea) {
      return Promise.resolve(DEFAULT_PREFERENCE);
    }

    return new Promise((resolve) => {
      try {
        storageArea.get({ [STORAGE_KEY]: DEFAULT_PREFERENCE }, (result: Record<string, unknown>) => {
          resolve(normalizePreference(result && result[STORAGE_KEY]));
        });
      } catch (_error) {
        resolve(DEFAULT_PREFERENCE);
      }
    });
  }

  function setPreference(preference: ThemePreference): Promise<ThemePreference> {
    const normalized = normalizePreference(preference);
    const storageArea = getStorageArea();
    if (!storageArea) {
      return Promise.resolve(normalized);
    }

    return new Promise((resolve, reject) => {
      try {
        storageArea.set({ [STORAGE_KEY]: normalized }, () => {
          const runtimeError = globalScope.chrome &&
            globalScope.chrome.runtime &&
            globalScope.chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(normalized);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function connect(element: HTMLElement): ThemeConnection {
    let preference: ThemePreference = DEFAULT_PREFERENCE;
    applyPreference(element, preference);

    const ready = getPreference().then((storedPreference) => {
      preference = storedPreference;
      applyPreference(element, preference);
      return preference;
    });

    const handleSystemChange = (): void => {
      if (preference === "system") {
        applyPreference(element, preference);
      }
    };

    const handleStorageChange = (
      changes: Record<string, ChromeStorageChange>,
      areaName: string
    ): void => {
      if (areaName !== "sync" || !changes[STORAGE_KEY]) {
        return;
      }
      preference = normalizePreference(changes[STORAGE_KEY]?.newValue);
      applyPreference(element, preference);
    };

    if (mediaQuery) {
      if (typeof mediaQuery.addEventListener === "function") {
        mediaQuery.addEventListener("change", handleSystemChange);
      } else if (typeof mediaQuery.addListener === "function") {
        mediaQuery.addListener(handleSystemChange);
      }
    }

    const storageEvents = globalScope.chrome &&
      globalScope.chrome.storage &&
      globalScope.chrome.storage.onChanged;
    if (storageEvents) {
      storageEvents.addListener(handleStorageChange);
    }

    return {
      ready,
      apply(nextPreference) {
        preference = normalizePreference(nextPreference);
        applyPreference(element, preference);
      },
      disconnect() {
        if (mediaQuery) {
          if (typeof mediaQuery.removeEventListener === "function") {
            mediaQuery.removeEventListener("change", handleSystemChange);
          } else if (typeof mediaQuery.removeListener === "function") {
            mediaQuery.removeListener(handleSystemChange);
          }
        }
        if (storageEvents) {
          storageEvents.removeListener(handleStorageChange);
        }
      }
    };
  }

  globalScope.JsonFormatterTheme = Object.freeze({
    connect,
    getPreference,
    setPreference,
    resolveTheme
  });
})(typeof window !== "undefined"
  ? window
  : globalThis as unknown as Window & typeof globalThis);
