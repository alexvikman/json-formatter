(function initFormatter() {
  "use strict";

  const rendererApi = window.JsonFormatterRenderer;
  window.JsonFormatterTheme.connect(document.documentElement);
  const editorView = document.getElementById("editor-view") as HTMLElement;
  const resultView = document.getElementById("result-view") as HTMLElement;
  const input = document.getElementById("json-input") as HTMLTextAreaElement;
  const errorBox = document.getElementById("parse-error") as HTMLDivElement;
  const resultContainer = document.getElementById("json-result") as HTMLDivElement;
  const rawResultContainer = document.getElementById("json-raw-result") as HTMLPreElement;
  const resultMeta = document.getElementById("result-meta") as HTMLParagraphElement;
  const resultTitle = document.getElementById("result-title") as HTMLHeadingElement;
  const copyStatus = document.getElementById("copy-status") as HTMLSpanElement;
  const copyButton = document.getElementById("copy-button") as HTMLButtonElement;
  const treeModeButton = document.getElementById("tree-mode-button") as HTMLButtonElement;
  const rawModeButton = document.getElementById("raw-mode-button") as HTMLButtonElement;
  const treeControls = document.getElementById("tree-controls") as HTMLDivElement;
  const formatButton = document.getElementById("format-button") as HTMLButtonElement;
  const settingsButton = document.getElementById("settings-button") as HTMLButtonElement;
  const editButton = document.getElementById("edit-button") as HTMLButtonElement;
  const collapseButton = document.getElementById("collapse-button") as HTMLButtonElement;
  const expandButton = document.getElementById("expand-button") as HTMLButtonElement;
  const clearButton = document.getElementById("clear-button") as HTMLButtonElement;

  let parsedValue: JsonValue = null;
  let compactJson = "";
  let activeTree: JsonTree | null = null;
  let viewMode: "tree" | "raw" = "tree";
  let statusTimer: number | undefined;

  function parseErrorDetails(error: unknown, source: string): string {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const positionMatch = message.match(/(?:position|at position)\s+(\d+)/i);
    if (!positionMatch) {
      return `Invalid JSON: ${message}`;
    }

    const position = Number(positionMatch[1]);
    const beforeError = source.slice(0, position);
    const lines = beforeError.split("\n");
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    return `Invalid JSON at line ${line}, column ${column}. ${message}`;
  }

  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }

  function clearError(): void {
    errorBox.textContent = "";
    errorBox.hidden = true;
    input.removeAttribute("aria-invalid");
  }

  function setCopyStatus(message: string): void {
    window.clearTimeout(statusTimer);
    copyStatus.textContent = message;
    if (message) {
      statusTimer = window.setTimeout(() => {
        copyStatus.textContent = "";
      }, 1800);
    }
  }

  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand("copy");
    textArea.remove();
    if (!copied) {
      throw new Error("Copy failed");
    }
  }

  async function copyCurrentJson(): Promise<void> {
    const text = viewMode === "raw"
      ? compactJson
      : JSON.stringify(parsedValue, null, 2);
    try {
      await copyText(text);
      setCopyStatus(viewMode === "raw" ? "Raw JSON copied" : "Formatted JSON copied");
    } catch (_error) {
      setCopyStatus("Could not copy");
    }
  }

  function setViewMode(mode: "tree" | "raw"): void {
    viewMode = mode;
    const showRaw = mode === "raw";
    resultContainer.hidden = showRaw;
    rawResultContainer.hidden = !showRaw;
    if (showRaw && !rawResultContainer.firstChild) {
      rawResultContainer.appendChild(rendererApi.renderRaw(compactJson));
    }
    treeControls.hidden = showRaw;
    treeModeButton.classList.toggle("is-active", !showRaw);
    rawModeButton.classList.toggle("is-active", showRaw);
    treeModeButton.setAttribute("aria-pressed", String(!showRaw));
    rawModeButton.setAttribute("aria-pressed", String(showRaw));
    resultTitle.textContent = showRaw ? "Raw JSON" : "Formatted JSON";
    copyButton.textContent = showRaw ? "Copy raw" : "Copy formatted";
    setCopyStatus("");
  }

  function showResult(): void {
    const source = input.value;
    if (!source.trim()) {
      showError("Paste JSON first.");
      input.focus();
      return;
    }

    try {
      parsedValue = rendererApi.parse(source);
    } catch (error) {
      showError(parseErrorDetails(error, source));
      input.focus();
      return;
    }

    clearError();
    compactJson = JSON.stringify(parsedValue);
    activeTree = rendererApi.render(parsedValue);
    resultContainer.replaceChildren(activeTree.element);
    rawResultContainer.replaceChildren();
    resultMeta.textContent = `${rendererApi.describeRoot(parsedValue)} · ${rendererApi.formatBytes(source)}`;
    setViewMode("tree");
    editorView.hidden = true;
    resultView.hidden = false;
    editButton.focus();
  }

  function showEditor(): void {
    resultView.hidden = true;
    editorView.hidden = false;
    setCopyStatus("");
    input.focus();
  }

  formatButton.addEventListener("click", showResult);
  settingsButton.addEventListener("click", () => {
    const runtime = window.chrome && window.chrome.runtime;
    if (runtime && typeof runtime.openOptionsPage === "function") {
      runtime.openOptionsPage();
    }
  });
  editButton.addEventListener("click", showEditor);
  copyButton.addEventListener("click", copyCurrentJson);
  treeModeButton.addEventListener("click", () => setViewMode("tree"));
  rawModeButton.addEventListener("click", () => setViewMode("raw"));
  collapseButton.addEventListener("click", () => {
    if (activeTree) {
      activeTree.collapseAll();
    }
  });
  expandButton.addEventListener("click", () => {
    if (activeTree) {
      activeTree.expandAll();
    }
  });
  clearButton.addEventListener("click", () => {
    input.value = "";
    clearError();
    input.focus();
  });

  input.addEventListener("input", clearError);
  input.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      showResult();
    }
  });
  input.addEventListener("paste", () => {
    window.setTimeout(() => {
      const source = input.value.trim();
      if (!source) {
        return;
      }
      try {
        JSON.parse(source);
        showResult();
      } catch (_error) {
        // Let the user finish editing or press Format JSON for a precise error location.
      }
    }, 0);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !resultView.hidden) {
      showEditor();
    }
  });

  input.focus();
})();
