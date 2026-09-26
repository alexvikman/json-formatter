(function initJsonFormatterRenderer(globalScope: Window & typeof globalThis) {
  "use strict";

  // Chrome's source-aware parser and raw JSON values preserve number tokens
  // without a JavaScript Number round trip. Keep the API typed for ES2022.
  const sourceJson = JSON as unknown as {
    parse(source: string, reviver: (key: string, value: JsonValue, context: { source?: string }) => JsonValue): JsonValue;
    rawJSON(source: string): JsonNumber;
    isRawJSON(value: unknown): value is JsonNumber;
  };

  function needsNumberSources(source: string): boolean {
    for (let position = 0; position < source.length; position += 1) {
      const character = source.charCodeAt(position);
      if (character === 34) {
        // Skip string contents, including escaped quotes, without tokenizing
        // large strings or mistaking a digit in a key/value for a JSON number.
        while (true) {
          const end = source.indexOf('"', position + 1);
          if (end === -1) {
            return false; // JSON.parse still validates the entire document.
          }
          let slash = end - 1;
          while (source.charCodeAt(slash) === 92) {
            slash -= 1;
          }
          position = end;
          if ((end - slash) % 2 === 1) {
            break;
          }
        }
      } else if (character === 45 || (character >= 48 && character <= 57)) {
        const start = position;
        let next: number;
        do {
          next = source.charCodeAt(++position);
        } while ((next >= 48 && next <= 57) || next === 46 || next === 69 || next === 101 ||
          next === 43 || next === 45);
        const token = source.slice(start, position);
        if (String(Number(token)) !== token) {
          return true;
        }
        position -= 1;
      }
    }
    return false;
  }

  function parse(source: string): JsonValue {
    if (typeof sourceJson.rawJSON !== "function") {
      throw new Error("Update Chrome to preserve JSON numbers without losing precision.");
    }
    // Avoid a reviver call and source context for every property when all
    // number tokens already survive the ordinary parser/stringifier exactly.
    if (!needsNumberSources(source)) {
      return JSON.parse(source) as JsonValue;
    }
    return sourceJson.parse(source, (_key, value, context) => {
      if (typeof value !== "number") {
        return value;
      }
      if (typeof context?.source !== "string") {
        throw new Error("Update Chrome to preserve JSON numbers without losing precision.");
      }
      // Ordinary numbers need no wrapper if serializing them is already exact.
      return String(value) === context.source ? value : sourceJson.rawJSON(context.source);
    });
  }

  interface ContainerEntry {
    key: string | null;
    value: JsonValue;
  }

  interface PrimitiveToken {
    className: string;
    text: string;
  }

  interface StringLink {
    href: string;
    start: number;
    end: number;
  }

  // Bound URL parsing and repeated href attributes when Raw splits a long token.
  const maxLinkLength = 16_384;

  interface ContainerState {
    value: JsonValue[] | JsonObject;
    siblings: ContainerState[];
    depth: number;
    node: HTMLDivElement;
    line: HTMLDivElement;
    closingLine: HTMLDivElement;
    toggle: HTMLButtonElement;
    children: HTMLDivElement;
    childrenBuilt: boolean;
    expanded: boolean;
    openingText: string;
    closingText: string;
    inlineTail?: HTMLSpanElement;
  }

  interface FlatTemplate {
    node: HTMLDivElement;
    key: string | null;
    opening: string;
    isLast: boolean;
    keys: Array<string | null>;
    classes: string[];
  }

  function createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    className?: string,
    text?: string
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function isContainer(value: JsonValue): value is JsonValue[] | JsonObject {
    return value !== null && typeof value === "object" && !sourceJson.isRawJSON(value);
  }

  function containerEntries(value: JsonValue[] | JsonObject): ContainerEntry[] {
    if (Array.isArray(value)) {
      return value.map((item) => ({ key: null, value: item }));
    }

    return Object.keys(value).map((key) => ({ key, value: value[key] }));
  }

  function primitiveToken(value: JsonPrimitive): PrimitiveToken {
    if (sourceJson.isRawJSON(value)) {
      return { className: "jf-number", text: value.rawJSON };
    }
    if (value === null) {
      return { className: "jf-null", text: "null" };
    }

    switch (typeof value) {
      case "string":
        return { className: "jf-string", text: JSON.stringify(value) };
      case "number":
        return { className: "jf-number", text: String(value) };
      case "boolean":
        return { className: "jf-boolean", text: String(value) };
      default:
        return { className: "jf-null", text: String(value) };
    }
  }

  function webLink(value: string): string | undefined {
    if (value.length > maxLinkLength || !/^https?:\/\//i.test(value) ||
        /[\s\u0000-\u001f\u007f]/.test(value)) {
      return undefined;
    }
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  }

  function createLink(text: string, href: string): HTMLAnchorElement {
    const link = createElement("a", "jf-link", text);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = "Open in a new tab";
    link.draggable = false;
    return link;
  }

  function preventSelectionNavigation(event: MouseEvent): void {
    // Chrome can still dispatch a click after dragging to select anchor text.
    // Keyboard activation has detail 0 and should follow the link normally.
    if (event.detail === 0) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest("a.jf-link") : null;
    const selection = globalScope.getSelection();
    if (link && selection && !selection.isCollapsed && selection.rangeCount &&
        selection.getRangeAt(0).intersectsNode(link)) {
      event.preventDefault();
    }
  }

  function rawStringLink(source: string, start: number, end: number): StringLink | undefined {
    const first = source[start + 1];
    // A JSON escape can use six code units for one decoded character.
    if (end - start > maxLinkLength * 6 + 2 || (first !== "h" && first !== "H" && first !== "\\")) {
      return undefined;
    }
    try {
      const href = webLink(JSON.parse(source.slice(start, end)) as string);
      return href ? { href, start: start + 1, end: end - 1 } : undefined;
    } catch {
      return undefined;
    }
  }

  function describeContainer(value: JsonValue[] | JsonObject): string {
    const count = Array.isArray(value) ? value.length : Object.keys(value).length;
    const noun = Array.isArray(value)
      ? count === 1 ? "item" : "items"
      : count === 1 ? "property" : "properties";
    return `${count} ${noun}`;
  }

  function describeRoot(value: JsonValue): string {
    if (sourceJson.isRawJSON(value)) {
      return "Number";
    }
    if (Array.isArray(value)) {
      return `Array · ${describeContainer(value)}`;
    }
    if (value !== null && typeof value === "object") {
      return `Object · ${describeContainer(value)}`;
    }
    if (value === null) {
      return "Null";
    }

    switch (typeof value) {
      case "string":
        return "String";
      case "number":
        return "Number";
      case "boolean":
        return "Boolean";
      default:
        return "Value";
    }
  }

  function formatBytes(source: string | number): string {
    const bytes = typeof source === "number"
      ? Math.max(0, source)
      : new TextEncoder().encode(String(source)).byteLength;
    if (bytes < 1000) {
      return `${bytes} B`;
    }
    if (bytes < 1000000) {
      return `${(bytes / 1000).toFixed(bytes < 10000 ? 1 : 0)} kB`;
    }
    return `${(bytes / 1000000).toFixed(1)} MB`;
  }

  function renderRaw(source: string): HTMLElement {
    const code = createElement("code", "jf-raw-code");
    code.tabIndex = 0;
    code.setAttribute("aria-label", "Raw JSON");
    const chunkLimit = 4_096;
    let chunk: HTMLSpanElement | null = null;
    let chunkLength = 0;

    const startChunk = (): HTMLSpanElement => {
      chunk = createElement("span", "jf-raw-chunk");
      chunkLength = 0;
      code.appendChild(chunk);
      return chunk;
    };
    const append = (start: number, end: number, className?: string, link?: StringLink): void => {
      // Keep short tokens together, but bound even a single multi-megabyte string.
      if (className && end - start <= chunkLimit && chunkLength + end - start > chunkLimit) {
        startChunk();
      }
      while (start < end) {
        const destination = chunk && chunkLength < chunkLimit ? chunk : startChunk();
        let stop = Math.min(end, start + chunkLimit - chunkLength);
        const lastCodeUnit = source.charCodeAt(stop - 1);
        const nextCodeUnit = source.charCodeAt(stop);
        if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff &&
            nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
          stop -= 1;
        }
        if (stop === start) {
          startChunk();
          continue;
        }
        const text = source.slice(start, stop);
        const token = className ? createElement("span", className, text) : text;
        if (link && typeof token !== "string") {
          const linkStart = Math.max(start, link.start);
          const linkEnd = Math.min(stop, link.end);
          if (linkStart < linkEnd) {
            token.replaceChildren(
              source.slice(start, linkStart),
              createLink(source.slice(linkStart, linkEnd), link.href),
              source.slice(linkEnd, stop)
            );
          }
        }
        destination.append(token);
        chunkLength += stop - start;
        start = stop;
      }
    };

    // Scan strings linearly: a long JSON string must not exhaust a regexp stack.
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    let position = 0;
    let plainStart = 0;
    while (position < source.length) {
      const character = source[position];
      let end = position;
      let className: string | undefined;
      if (character === '"') {
        end += 1;
        while (end < source.length) {
          if (source[end] === "\\") {
            end += 2;
          } else if (source[end++] === '"') {
            break;
          }
        }
        let next = end;
        while (/\s/.test(source[next] || "")) {
          next += 1;
        }
        className = source[next] === ":" ? "jf-key" : "jf-string";
      } else if (character === "-" || (character >= "0" && character <= "9")) {
        number.lastIndex = position;
        const match = number.exec(source);
        if (match) {
          end = number.lastIndex;
          className = "jf-number";
        }
      } else if (source.startsWith("true", position) || source.startsWith("null", position)) {
        end += 4;
        className = character === "n" ? "jf-null" : "jf-boolean";
      } else if (source.startsWith("false", position)) {
        end += 5;
        className = "jf-boolean";
      }
      if (className) {
        append(plainStart, position);
        append(position, end, className,
          className === "jf-string" ? rawStringLink(source, position, end) : undefined);
        position = plainStart = end;
      } else {
        position += 1;
      }
    }
    append(plainStart, source.length);

    code.addEventListener("click", preventSelectionNavigation);
    code.addEventListener("pointerdown", () => code.focus({ preventScroll: true }));
    code.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = globalScope.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        event.preventDefault();
      }
    });
    code.addEventListener("copy", (event) => {
      const selection = globalScope.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) {
        return;
      }
      const range = selection.getRangeAt(0);
      if (code.contains(range.startContainer) && code.contains(range.endContainer)) {
        // Range text excludes the visual line breaks between rendering chunks.
        event.clipboardData.setData("text/plain", range.toString());
        event.preventDefault();
      }
    });
    return code;
  }

  class JsonTreeRenderer implements JsonTree {
    value: JsonValue;
    options: { expandedDepth: number };
    containerStates: ContainerState[];
    element: HTMLDivElement;
    statesByNode = new WeakMap<Element, ContainerState>();
    // Count constructed rows without allocating bookkeeping for each leaf.
    createdRows = 0;
    chunks: HTMLDivElement[] = [];
    widestLineColumns = 0;
    // Templates contain structure, keys and punctuation; values are always
    // filled as text after cloning. Limit caches for heterogeneous documents.
    primitiveTemplates = new Map<string | null, Map<string, HTMLDivElement>>();
    flatTemplates = new Map<string, FlatTemplate>();
    lastFlatTemplate?: FlatTemplate;
    keyLengths = new Map<string, number>();
    containerTemplate: HTMLDivElement;

    constructor(value: JsonValue, options?: { expandedDepth?: number }) {
      this.value = value;
      this.options = Object.assign({ expandedDepth: Number.POSITIVE_INFINITY }, options || {});
      this.containerStates = [];
      this.element = createElement("div", "jf-tree");
      this.element.setAttribute("role", "tree");
      this.element.setAttribute("aria-label", "Formatted JSON");
      this.containerTemplate = this.createContainerTemplate();

      const rootNode = this.createNode(value, null, 0, true);
      this.element.appendChild(rootNode);
      this.updateChunkWidths();
      this.element.addEventListener("copy", (event) => this.copySelection(event));
      this.element.addEventListener("click", (event) => {
        preventSelectionNavigation(event);
        const toggle = event.target instanceof Element ? event.target.closest(".jf-toggle") : null;
        const node = toggle?.parentElement?.parentElement;
        const state = node ? this.statesByNode.get(node) : undefined;
        if (state) {
          const expanded = !state.expanded;
          const targets = !expanded && (event.ctrlKey || event.metaKey) ? state.siblings : [state];
          const affectedChunks = new Set<HTMLDivElement>();
          for (const target of targets) {
            if (target.expanded === expanded) {
              continue;
            }
            this.setExpanded(target, expanded);
            let chunk = target.node.closest<HTMLDivElement>(".jf-render-chunk");
            while (chunk) {
              affectedChunks.add(chunk);
              chunk = chunk.parentElement?.closest<HTMLDivElement>(".jf-render-chunk") ?? null;
            }
          }
          // Siblings can span several layout chunks. Refresh each chunk once.
          for (const chunk of affectedChunks) {
            this.updateChunkHeight(chunk);
          }
          this.updateChunkWidths();
        }
      });
    }

    updateLineWidth(depth: number, columns: number): void {
      this.widestLineColumns = Math.max(this.widestLineColumns, columns + depth * 4);
    }

    keyLength(key: string | null): number {
      if (key === null) {
        return 0;
      }
      let length = this.keyLengths.get(key);
      if (length === undefined) {
        length = JSON.stringify(key).length + 2;
        if (this.keyLengths.size < 256) {
          this.keyLengths.set(key, length);
        }
      }
      return length;
    }

    lineMetadata(line: HTMLElement): { depth: number; text: string } {
      // Derive selection metadata only when copying. Primitive rows already
      // contain their exact JSON text, including any escaped link contents.
      const parent = line.parentElement?.closest(".jf-container-node");
      const owner = parent ? this.statesByNode.get(parent) : undefined;
      if (owner && line === owner.line) {
        return { depth: owner.depth, text: owner.openingText };
      }
      return {
        depth: owner ? owner.depth + Number(line !== owner.closingLine) : 0,
        text: line.textContent!
      };
    }

    isVisibleLine(line: HTMLElement, boundary: HTMLElement = this.element): boolean {
      for (let parent = line.parentElement; parent && parent !== boundary; parent = parent.parentElement) {
        if (parent.classList.contains("is-collapsed") && parent.firstElementChild !== line) {
          return false;
        }
      }
      return true;
    }

    updateChunkHeight(chunk: HTMLDivElement): void {
      const rows = Array.from(chunk.querySelectorAll<HTMLElement>(".jf-line"))
        .reduce((count, line) => count + Number(this.isVisibleLine(line, chunk)), 0);
      chunk.style.containIntrinsicBlockSize = `${rows * 22}px`;
    }

    updateChunkWidths(): void {
      // Reserve a conservative monospace width even while a chunk is offscreen.
      for (const chunk of this.chunks) {
        chunk.style.containIntrinsicInlineSize = `calc(${this.widestLineColumns}ch + 27px)`;
      }
    }

    copySelection(event: ClipboardEvent): void {
      const selection = globalScope.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) {
        return;
      }

      const anchorElement = selection.anchorNode && (
        selection.anchorNode.nodeType === Node.ELEMENT_NODE
          ? selection.anchorNode
          : selection.anchorNode.parentElement
      );
      const focusElement = selection.focusNode && (
        selection.focusNode.nodeType === Node.ELEMENT_NODE
          ? selection.focusNode
          : selection.focusNode.parentElement
      );
      if (!anchorElement || !focusElement ||
          !this.element.contains(anchorElement) || !this.element.contains(focusElement)) {
        return;
      }

      const range = selection.getRangeAt(0);
      const selectedLines: Array<{ depth: number; text: string }> = [];
      for (const line of this.element.querySelectorAll<HTMLElement>(".jf-line")) {
        if (!this.isVisibleLine(line) || !range.intersectsNode(line)) {
          continue;
        }
        const metadata = this.lineMetadata(line);
        const state = line.parentElement ? this.statesByNode.get(line.parentElement) : undefined;
        const folded = state && line === state.line && !state.expanded;
        const visibleLength = folded ? line.textContent!.length : metadata.text.length;
        const offsetInLine = (node: Node, offset: number, fallback: number): number => {
          if (!line.contains(node)) {
            return fallback;
          }
          const prefix = document.createRange();
          prefix.selectNodeContents(line);
          prefix.setEnd(node, offset);
          return Math.min(visibleLength, prefix.toString().length);
        };
        const start = offsetInLine(range.startContainer, range.startOffset, 0);
        const end = offsetInLine(range.endContainer, range.endOffset, visibleLength);
        if (start >= end) {
          continue;
        }

        let text: string;
        const valueStart = metadata.text.length - 1;
        if (folded) {
          // A folded value is an atomic selection. Include its actual contents,
          // not the visual item-count label or an unmatched opening bracket.
          const key = metadata.text.slice(0, valueStart);
          const comma = state.closingText.endsWith(",") ? "," : "";
          const valueEnd = visibleLength - comma.length;
          text = key.slice(start, end);
          if (start < valueEnd && end > valueStart) {
            text += JSON.stringify(state.value, null, 2);
          }
          if (end > valueEnd) {
            text += comma;
          }
        } else {
          // Preserve exact first/last character boundaries, even across lines.
          text = metadata.text.slice(start, end);
        }
        selectedLines.push({ depth: metadata.depth, text });
      }
      if (selectedLines.length === 0) {
        return;
      }

      const minimumDepth = selectedLines.reduce((minimum, line) =>
        Math.min(minimum, line.depth), Number.POSITIVE_INFINITY);
      const formattedSelection = selectedLines.map((line) => {
        const indentation = "  ".repeat(line.depth - minimumDepth);
        return indentation + line.text.replaceAll("\n", `\n${indentation}`);
      }).join("\n");

      event.preventDefault();
      event.clipboardData.setData("text/plain", formattedSelection);
    }

    appendKey(line: HTMLElement, key: string | null): void {
      if (key === null) {
        return;
      }

      line.append(createElement("span", "jf-key", JSON.stringify(key)), ": ");
    }

    createNode(
      value: JsonValue, key: string | null, depth: number, isLast: boolean,
      siblings: ContainerState[] = []
    ): HTMLDivElement {
      if (!isContainer(value)) {
        return this.createPrimitiveNode(value, key, depth, isLast);
      }

      return this.createContainerNode(value, key, depth, isLast, siblings);
    }

    createPrimitiveNode(
      value: JsonPrimitive,
      key: string | null,
      depth: number,
      isLast: boolean
    ): HTMLDivElement {
      const token = primitiveToken(value);
      const line = this.primitiveTemplate(key, token.className, isLast).cloneNode(true) as HTMLDivElement;
      this.fillPrimitive(line, value, token, key, depth, isLast);
      return line;
    }

    primitiveTemplate(key: string | null, className: string, isLast: boolean): HTMLDivElement {
      let templates = this.primitiveTemplates.get(key);
      if (!templates) {
        templates = new Map();
        if (this.primitiveTemplates.size < 256) {
          this.primitiveTemplates.set(key, templates);
        }
      }
      const templateKey = `${className}${isLast ? "" : ","}`;
      let template = templates.get(templateKey);
      if (!template) {
        template = createElement("div", "jf-node jf-primitive-node jf-line");
        template.setAttribute("role", "treeitem");
        this.appendKey(template, key);
        template.appendChild(createElement("span", `jf-value ${className}`));
        if (!isLast) {
          template.append(",");
        }
        templates.set(templateKey, template);
      }
      return template;
    }

    fillPrimitive(
      line: HTMLDivElement, value: JsonPrimitive, token: PrimitiveToken,
      key: string | null, depth: number, isLast: boolean
    ): void {
      const element = line.lastElementChild!;
      element.textContent = token.text;
      const href = typeof value === "string" ? webLink(value) : undefined;
      if (href) {
        element.replaceChildren('"', createLink(token.text.slice(1, -1), href), '"');
      }
      this.updateLineWidth(depth, this.keyLength(key) + token.text.length + Number(!isLast));
      this.createdRows += 1;
    }

    createContainerTemplate(): HTMLDivElement {
      const node = createElement("div", "jf-node jf-container-node");
      node.setAttribute("role", "treeitem");
      const line = createElement("div", "jf-line jf-container-line");
      const toggle = createElement("button", "jf-toggle");
      toggle.type = "button";
      toggle.setAttribute("aria-label", "Collapse");
      toggle.setAttribute("aria-expanded", "true");
      toggle.title = "Collapse (Ctrl/Cmd+click to collapse siblings)";
      line.appendChild(toggle);
      const children = createElement("div", "jf-children");
      children.setAttribute("role", "group");
      children.setAttribute("aria-hidden", "false");
      const closingLine = createElement("div", "jf-line jf-closing-line");
      closingLine.setAttribute("aria-hidden", "false");
      node.append(line, children, closingLine);
      return node;
    }

    createContainerNode(
      value: JsonValue[] | JsonObject,
      key: string | null,
      depth: number,
      isLast: boolean,
      siblings: ContainerState[]
    ): HTMLDivElement {
      const entries = containerEntries(value);
      if (entries.length === 0) {
        return this.createEmptyContainerNode(value, key, depth, isLast);
      }

      const shouldExpand = depth < this.options.expandedDepth;
      const tokens = shouldExpand && entries.length < 64 && entries.every((entry) => !isContainer(entry.value))
        ? entries.map((entry) => primitiveToken(entry.value as JsonPrimitive)) : null;
      const opening = Array.isArray(value) ? "[" : "{";
      const closing = Array.isArray(value) ? "]" : "}";
      const closingText = `${closing}${isLast ? "" : ","}`;
      let template = this.containerTemplate;
      if (tokens) {
        // Consecutive records commonly share a shape. Compare it directly to
        // avoid allocating and serializing a cache key for every record.
        let flatTemplate = this.lastFlatTemplate;
        let signature = "";
        if (!flatTemplate || flatTemplate.key !== key || flatTemplate.opening !== opening ||
            flatTemplate.isLast !== isLast || flatTemplate.keys.length !== entries.length ||
            entries.some((entry, index) => entry.key !== flatTemplate!.keys[index] ||
              tokens[index].className !== flatTemplate!.classes[index])) {
          signature = JSON.stringify([key, opening, isLast,
            entries.map((entry, index) => [entry.key, tokens[index].className])]);
          flatTemplate = this.flatTemplates.get(signature);
        }
        if (!flatTemplate) {
          const node = this.containerTemplate.cloneNode(true) as HTMLDivElement;
          this.appendKey(node.firstElementChild as HTMLElement, key);
          node.firstElementChild!.append(opening);
          node.lastElementChild!.textContent = closingText;
          const children = node.children[1];
          entries.forEach((entry, index) => children.appendChild(
            this.primitiveTemplate(entry.key, tokens[index].className, index === entries.length - 1).cloneNode(true)
          ));
          flatTemplate = {
            node, key, opening, isLast, keys: entries.map((entry) => entry.key),
            classes: tokens.map((token) => token.className)
          };
          if (this.flatTemplates.size < 128) {
            this.flatTemplates.set(signature, flatTemplate);
          }
        }
        this.lastFlatTemplate = flatTemplate;
        template = flatTemplate.node;
      }
      const node = template.cloneNode(true) as HTMLDivElement;
      const line = node.firstElementChild as HTMLDivElement;
      const toggle = line.firstElementChild as HTMLButtonElement;
      if (!tokens) {
        this.appendKey(line, key);
        line.append(opening);
      }
      const keyText = key === null ? "" : `${JSON.stringify(key)}: `;
      this.updateLineWidth(depth, keyText.length + 1);

      const children = line.nextElementSibling as HTMLDivElement;
      const closingLine = node.lastElementChild as HTMLDivElement;
      if (!tokens) {
        closingLine.textContent = closingText;
      }
      this.updateLineWidth(depth, closingText.length);

      const state = {
        value,
        siblings,
        depth,
        node,
        line,
        closingLine,
        toggle,
        children,
        childrenBuilt: false,
        expanded: true,
        openingText: `${keyText}${opening}`,
        closingText
      };
      this.containerStates.push(state);
      siblings.push(state);
      this.statesByNode.set(node, state);

      if (shouldExpand) {
        this.createdRows += 2;
        if (tokens) {
          let child = children.firstElementChild as HTMLDivElement;
          entries.forEach((entry, index) => {
            this.fillPrimitive(child, entry.value as JsonPrimitive, tokens[index], entry.key, depth + 1,
              index === entries.length - 1);
            child = child.nextElementSibling as HTMLDivElement;
          });
          state.childrenBuilt = true;
        } else {
          this.buildChildren(state, entries);
        }
      } else {
        this.createdRows += 1;
        this.setExpanded(state, false);
      }
      return node;
    }

    createEmptyContainerNode(
      value: JsonValue[] | JsonObject,
      key: string | null,
      depth: number,
      isLast: boolean
    ): HTMLDivElement {
      const line = createElement("div", "jf-node jf-empty-node jf-line");
      line.setAttribute("role", "treeitem");
      this.appendKey(line, key);
      const keyText = key === null ? "" : `${JSON.stringify(key)}: `;
      const emptyValue = Array.isArray(value) ? "[]" : "{}";
      line.append(`${emptyValue}${isLast ? "" : ","}`);
      this.updateLineWidth(depth, keyText.length + 2 + Number(!isLast));
      this.createdRows += 1;
      return line;
    }

    buildChildren(state: ContainerState, entries?: ContainerEntry[]): void {
      if (state.childrenBuilt) {
        return;
      }
      entries ??= containerEntries(state.value);

      let chunk: HTMLDivElement | null = null;
      let chunkRows = 0;
      const siblings: ContainerState[] = [];
      entries.forEach((entry, index) => {
        if (entries.length >= 64 && index % 64 === 0) {
          chunk = createElement("div", "jf-render-chunk");
          chunk.setAttribute("role", "presentation");
          this.chunks.push(chunk);
          state.children.appendChild(chunk);
          chunkRows = 0;
        }
        const rowsBefore = this.createdRows;
        const child = this.createNode(
          entry.value,
          entry.key,
          state.depth + 1,
          index === entries.length - 1,
          siblings
        );
        (chunk ?? state.children).appendChild(child);
        chunkRows += this.createdRows - rowsBefore;
        if (chunk && (index % 64 === 63 || index === entries.length - 1)) {
          chunk.style.containIntrinsicBlockSize = `${chunkRows * 22}px`;
        }
      });
      state.childrenBuilt = true;
    }

    setExpanded(state: ContainerState, expanded: boolean): void {
      if (expanded) {
        this.buildChildren(state);
      } else if (!state.inlineTail) {
        state.inlineTail = createElement("span", "jf-inline-tail");
        state.inlineTail.setAttribute("aria-hidden", "true");
        state.inlineTail.append(
          createElement("span", "jf-summary", describeContainer(state.value)),
          state.closingText
        );
        state.line.appendChild(state.inlineTail);
      }

      state.expanded = expanded;
      state.node.classList.toggle("is-collapsed", !expanded);
      state.toggle.setAttribute("aria-expanded", String(expanded));
      state.toggle.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
      state.toggle.title = expanded ? "Collapse (Ctrl/Cmd+click to collapse siblings)" : "Expand";
      state.children.setAttribute("aria-hidden", String(!expanded));
      state.closingLine.setAttribute("aria-hidden", String(!expanded));
    }

    collapseAll(): void {
      for (let index = this.containerStates.length - 1; index >= 0; index -= 1) {
        this.setExpanded(this.containerStates[index], false);
      }
    }

    expandAll(): void {
      let index = 0;
      while (index < this.containerStates.length) {
        this.setExpanded(this.containerStates[index], true);
        index += 1;
      }
      for (const chunk of this.chunks) {
        this.updateChunkHeight(chunk);
      }
      this.updateChunkWidths();
    }
  }

  globalScope.JsonFormatterRenderer = Object.freeze({
    parse,
    render(value: JsonValue, options?: { expandedDepth?: number }): JsonTree {
      return new JsonTreeRenderer(value, options);
    },
    renderRaw,
    describeRoot,
    formatBytes
  });
})(typeof window !== "undefined"
  ? window
  : globalThis as unknown as Window & typeof globalThis);
