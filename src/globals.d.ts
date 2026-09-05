interface JsonNumber {
  readonly rawJSON: string;
}

type JsonPrimitive = string | number | boolean | null | JsonNumber;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

interface ThemeConnection {
  ready: Promise<ThemePreference>;
  apply(preference: ThemePreference): void;
  disconnect(): void;
}

interface JsonFormatterThemeApi {
  connect(element: HTMLElement): ThemeConnection;
  getPreference(): Promise<ThemePreference>;
  setPreference(preference: ThemePreference): Promise<ThemePreference>;
  resolveTheme(preference: ThemePreference): ResolvedTheme;
}

interface JsonTree {
  element: HTMLDivElement;
  collapseAll(): void;
  expandAll(): void;
}

interface JsonFormatterRendererApi {
  parse(source: string): JsonValue;
  render(value: JsonValue, options?: { expandedDepth?: number }): JsonTree;
  renderRaw(source: string): HTMLElement;
  describeRoot(value: JsonValue): string;
  formatBytes(source: string | number): string;
}

interface ChromeStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

interface ChromeStorageArea {
  get(
    defaults: Record<string, unknown>,
    callback: (result: Record<string, unknown>) => void
  ): void;
  set(values: Record<string, unknown>, callback?: () => void): void;
}

interface ChromeStorageEvents {
  addListener(
    listener: (changes: Record<string, ChromeStorageChange>, areaName: string) => void
  ): void;
  removeListener(
    listener: (changes: Record<string, ChromeStorageChange>, areaName: string) => void
  ): void;
}

interface ChromeApi {
  runtime?: {
    lastError?: { message: string };
    openOptionsPage?: () => void | Promise<void>;
  };
  storage?: {
    sync: ChromeStorageArea;
    onChanged: ChromeStorageEvents;
  };
}

interface Window {
  JsonFormatterTheme: JsonFormatterThemeApi;
  JsonFormatterRenderer: JsonFormatterRendererApi;
  chrome?: ChromeApi;
}
