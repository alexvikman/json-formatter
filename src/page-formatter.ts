(function formatJsonResponsePage() {
  "use strict";

  const rendererApi = window.JsonFormatterRenderer;
  if (!rendererApi || !document.body) {
    return;
  }

  function getJsonCandidate(): string | null {
    const contentType = (document.contentType || "").toLowerCase();
    const isJsonResponse = contentType.includes("json");
    const isPlainText = contentType === "text/plain";

    if (!isJsonResponse && !isPlainText) {
      return null;
    }

    if (isPlainText) {
      const visibleChildren = Array.from(document.body.children).filter((element) => {
        return element.tagName !== "SCRIPT" && element.tagName !== "STYLE";
      });
      const isRawDocument = visibleChildren.length === 0 ||
        (visibleChildren.length === 1 && visibleChildren[0].tagName === "PRE");

      if (!isRawDocument) {
        return null;
      }
    }

    const rawText = document.body.textContent;
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      return null;
    }

    if (isPlainText && !trimmedText.startsWith("{") && !trimmedText.startsWith("[")) {
      return null;
    }

    return rawText;
  }

  function createButton(label: string, className?: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className || "jf-page-button";
    button.textContent = label;
    return button;
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

  const rawJson = getJsonCandidate();
  if (rawJson === null) {
    return;
  }

  let parsedJson: JsonValue;
  try {
    parsedJson = rendererApi.parse(rawJson);
  } catch (_error) {
    return;
  }
  const compactJson = JSON.stringify(parsedJson);
  window.JsonFormatterTheme.connect(document.documentElement);

  const app = document.createElement("div");
  app.className = "jf-page-app";

  const header = document.createElement("header");
  header.className = "jf-app-header jf-page-header";

  const identity = document.createElement("div");
  identity.className = "jf-brand";
  const mark = document.createElement("span");
  mark.className = "jf-brand-mark";
  mark.textContent = "{ }";
  mark.setAttribute("aria-hidden", "true");
  const titleGroup = document.createElement("div");
  const title = document.createElement("h1");
  title.className = "jf-brand-title";
  title.textContent = "JSON Formatter";
  const meta = document.createElement("span");
  meta.className = "jf-brand-subtitle";
  meta.textContent = `${rendererApi.describeRoot(parsedJson)} · ${rendererApi.formatBytes(rawJson)}`;
  titleGroup.append(title, meta);
  identity.append(mark, titleGroup);

  const actions = document.createElement("div");
  actions.className = "jf-page-actions";
  const viewSwitch = document.createElement("div");
  viewSwitch.className = "jf-page-view-switch";
  viewSwitch.setAttribute("role", "group");
  viewSwitch.setAttribute("aria-label", "JSON view");
  const treeModeButton = createButton("Tree", "jf-page-mode-button is-active");
  const rawModeButton = createButton("Raw", "jf-page-mode-button");
  treeModeButton.setAttribute("aria-pressed", "true");
  rawModeButton.setAttribute("aria-pressed", "false");
  viewSwitch.append(treeModeButton, rawModeButton);
  const collapseButton = createButton("Collapse all");
  const expandButton = createButton("Expand all");
  const copyButton = createButton("Copy formatted", "jf-page-button jf-page-primary-button");
  const copyStatus = document.createElement("span");
  copyStatus.className = "jf-page-status";
  copyStatus.setAttribute("role", "status");
  copyStatus.setAttribute("aria-live", "polite");
  actions.append(viewSwitch, collapseButton, expandButton, copyButton, copyStatus);

  header.append(identity, actions);

  const content = document.createElement("main");
  content.className = "jf-page-content";
  const tree = rendererApi.render(parsedJson);
  const rawView = document.createElement("pre");
  rawView.className = "jf-page-raw";
  rawView.setAttribute("aria-label", "Raw JSON");
  rawView.hidden = true;
  content.append(tree.element, rawView);

  let viewMode: "tree" | "raw" = "tree";

  function setViewMode(mode: "tree" | "raw"): void {
    viewMode = mode;
    const showRaw = mode === "raw";
    tree.element.hidden = showRaw;
    rawView.hidden = !showRaw;
    if (showRaw && !rawView.firstChild) {
      rawView.appendChild(rendererApi.renderRaw(compactJson));
    }
    collapseButton.hidden = showRaw;
    expandButton.hidden = showRaw;
    treeModeButton.classList.toggle("is-active", !showRaw);
    rawModeButton.classList.toggle("is-active", showRaw);
    treeModeButton.setAttribute("aria-pressed", String(!showRaw));
    rawModeButton.setAttribute("aria-pressed", String(showRaw));
    copyButton.textContent = showRaw ? "Copy raw" : "Copy formatted";
    copyStatus.textContent = "";
  }

  treeModeButton.addEventListener("click", () => setViewMode("tree"));
  rawModeButton.addEventListener("click", () => setViewMode("raw"));
  collapseButton.addEventListener("click", () => tree.collapseAll());
  expandButton.addEventListener("click", () => tree.expandAll());
  copyButton.addEventListener("click", async () => {
    try {
      const text = viewMode === "raw" ? compactJson : JSON.stringify(parsedJson, null, 2);
      await copyText(text);
      copyStatus.textContent = viewMode === "raw" ? "Raw JSON copied" : "Formatted JSON copied";
      copyButton.textContent = "Copied!";
      window.setTimeout(() => {
        copyStatus.textContent = "";
        copyButton.textContent = viewMode === "raw" ? "Copy raw" : "Copy formatted";
      }, 1600);
    } catch (_error) {
      copyStatus.textContent = "Could not copy";
    }
  });

  app.append(header, content);
  document.documentElement.classList.add("jf-page-active");
  document.body.replaceChildren(app);
})();
