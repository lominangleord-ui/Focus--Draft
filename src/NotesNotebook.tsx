import { memo, useEffect, useMemo, useRef, useState } from "react";

type NoteFont = "sans" | "serif" | "hand" | "mono" | "print";
type NoteSummary = {
  id: string;
  title: string;
  preview: string;
  font: NoteFont;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
};
type NotebookNote = NoteSummary & { content: string };
type EditorCommand = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList" | "formatBlock" | "undo" | "redo";

const DB_NAME = "focusdash_notebook";
const DB_VERSION = 1;
const LEGACY_NOTE_ID = "legacy-memo-import-v1";
const EMPTY_NOTE_HTML = "";
const SAVE_DELAY = 500;
const FONT_OPTIONS: { id: NoteFont; label: string; family: string }[] = [
  { id: "sans", label: "Inter · Sans", family: '"Inter", system-ui, sans-serif' },
  { id: "serif", label: "Fraunces · Serif", family: '"Fraunces", Georgia, serif' },
  { id: "hand", label: "Caveat · Handwritten", family: '"Caveat", cursive' },
  { id: "print", label: "Patrick Hand · Print", family: '"Patrick Hand", cursive' },
  { id: "mono", label: "JetBrains · Mono", family: '"JetBrains Mono", monospace' },
];
const ALLOWED_TAGS = new Set([
  "A", "B", "BLOCKQUOTE", "BR", "CODE", "DIV", "EM", "FIGCAPTION", "FIGURE",
  "H1", "H2", "H3", "HR", "I", "IMG", "LI", "OL", "P", "PRE", "S", "STRONG",
  "U", "UL",
]);
const BLOCKED_TAGS = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"]);
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i;
let dbPromise: Promise<IDBDatabase> | null = null;
let clearingDb = false;

export async function clearNotebookStorage() {
  clearingDb = true;
  if (dbPromise) {
    try { (await dbPromise).close(); } catch { /* the database may never have opened */ }
  }
  dbPromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Could not erase notebook storage."));
    request.onblocked = () => reject(new Error("Close other Focus tabs before erasing notebook data."));
  });
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function openNotebookDb(): Promise<IDBDatabase> {
  if (clearingDb) return Promise.reject(new Error("Notebook storage is being erased."));
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is not available in this browser."));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("bodies")) db.createObjectStore("bodies", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not open local notebook storage."));
    request.onblocked = () => reject(new Error("Notebook storage is busy in another tab. Close the other tab and try again."));
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise!;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Notebook storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Notebook storage transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Notebook storage transaction was interrupted."));
  });
}

function toSummary(note: NotebookNote): NoteSummary {
  const { content: _content, ...summary } = note;
  return summary;
}

function sortNotes(notes: NoteSummary[]) {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

async function listNoteSummaries(): Promise<NoteSummary[]> {
  const db = await openNotebookDb();
  const transaction = db.transaction("notes", "readonly");
  const complete = transactionComplete(transaction);
  const result = await requestValue(transaction.objectStore("notes").getAll() as IDBRequest<NoteSummary[]>);
  await complete;
  return result;
}

async function readNotebookNote(id: string): Promise<NotebookNote | null> {
  const db = await openNotebookDb();
  const transaction = db.transaction(["notes", "bodies"], "readonly");
  const complete = transactionComplete(transaction);
  const metaRequest = transaction.objectStore("notes").get(id) as IDBRequest<NoteSummary | undefined>;
  const bodyRequest = transaction.objectStore("bodies").get(id) as IDBRequest<{ id: string; content: string } | undefined>;
  const [meta, body] = await Promise.all([requestValue(metaRequest), requestValue(bodyRequest)]);
  await complete;
  return meta ? { ...meta, content: body?.content ?? EMPTY_NOTE_HTML } : null;
}

async function writeNotebookNote(note: NotebookNote) {
  const db = await openNotebookDb();
  const transaction = db.transaction(["notes", "bodies"], "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore("notes").put(toSummary(note));
  transaction.objectStore("bodies").put({ id: note.id, content: note.content });
  await complete;
}

async function removeNotebookNote(id: string) {
  const db = await openNotebookDb();
  const transaction = db.transaction(["notes", "bodies"], "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore("notes").delete(id);
  transaction.objectStore("bodies").delete(id);
  await complete;
}

function safeLink(value: string): string | null {
  const raw = value.trim().replace(/^<|>$/g, "");
  if (!raw) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return `mailto:${raw}`;
  const looksLikeDomain = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i.test(raw);
  const withProtocol = looksLikeDomain && !/^[a-z][a-z0-9+.-]*:/i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(withProtocol);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizeNoteHtml(source: string): string {
  if (!source) return "";
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const result = document.createElement("div");

  const copyChildren = (sourceNode: Node, target: Node) => {
    for (const child of Array.from(sourceNode.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (!(child instanceof Element)) continue;
      if (BLOCKED_TAGS.has(child.tagName)) continue;

      if (child.tagName === "IMG") {
        const src = child.getAttribute("src") ?? "";
        if (!IMAGE_DATA_URL.test(src) || src.length > 6_000_000) continue;
        const image = document.createElement("img");
        image.src = src;
        image.alt = (child.getAttribute("alt") ?? "Image").slice(0, 200);
        target.appendChild(image);
        continue;
      }

      if (child.tagName === "A") {
        const href = safeLink(child.getAttribute("href") ?? "");
        if (!href) {
          copyChildren(child, target);
          continue;
        }
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        copyChildren(child, anchor);
        target.appendChild(anchor);
        continue;
      }

      if (!ALLOWED_TAGS.has(child.tagName)) {
        copyChildren(child, target);
        continue;
      }
      const clean = document.createElement(child.tagName.toLowerCase());
      copyChildren(child, clean);
      target.appendChild(clean);
    }
  };

  copyChildren(parsed.body, result);
  return result.innerHTML;
}

function plainTextFromHtml(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "\"") return "&quot;";
    return "&#39;";
  });
}

function legacyTextToHtml(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
    .join("");
}

function formatUpdatedAt(value: number) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `Today, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function autoLinkTextNodes(root: HTMLElement) {
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"']+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest("a, code, pre, script, style")) continue;
    if (pattern.test(node.data)) {
      textNodes.push(node);
      pattern.lastIndex = 0;
    }
  }

  for (const textNode of textNodes) {
    const source = textNode.data;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const raw = match[0];
      let urlText = raw;
      let trailing = "";
      while (/[.,!?;:)\]}]$/.test(urlText)) {
        trailing = urlText.slice(-1) + trailing;
        urlText = urlText.slice(0, -1);
      }
      const href = safeLink(urlText);
      if (!href || !urlText) continue;
      if (match.index > cursor) fragment.appendChild(document.createTextNode(source.slice(cursor, match.index)));
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.textContent = urlText;
      fragment.appendChild(anchor);
      if (trailing) fragment.appendChild(document.createTextNode(trailing));
      cursor = match.index + raw.length;
    }
    if (cursor === 0) continue;
    if (cursor < source.length) fragment.appendChild(document.createTextNode(source.slice(cursor)));
    textNode.parentNode?.replaceChild(fragment, textNode);
  }
}

async function imageFileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 20 * 1024 * 1024) throw new Error("That image is too large. Choose one under 20 MB.");

  let width = 0;
  let height = 0;
  let draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    draw = (context, w, h) => context.drawImage(bitmap!, 0, 0, w, h);
  } catch {
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("This image could not be opened."));
        element.src = objectUrl;
      });
      width = image.naturalWidth;
      height = image.naturalHeight;
      draw = (context, w, h) => context.drawImage(image, 0, 0, w, h);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  if (!width || !height) {
    bitmap?.close();
    throw new Error("This image could not be opened.");
  }
  const scale = Math.min(1, 1800 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap?.close();
    throw new Error("This browser could not prepare the image.");
  }
  draw!(context, canvas.width, canvas.height);
  bitmap?.close();

  const preserveAlpha = /png|gif|webp|avif/i.test(file.type);
  const webp = canvas.toDataURL("image/webp", 0.84);
  const data = webp.startsWith("data:image/webp")
    ? webp
    : canvas.toDataURL(preserveAlpha ? "image/png" : "image/jpeg", 0.84);
  if (data.length > 6_000_000) throw new Error("This image is still too large after optimization. Try a smaller picture.");
  return data;
}

function newNotebookNote(title = "Untitled note", id: string = makeId()): NotebookNote {
  const now = Date.now();
  return { id, title, preview: "", content: EMPTY_NOTE_HTML, font: "sans", pinned: false, createdAt: now, updatedAt: now };
}

function RichEditor({
  noteId,
  initialHtml,
  font,
  onChange,
  onMessage,
}: {
  noteId: string;
  initialHtml: string;
  font: NoteFont;
  onChange: (id: string, html: string, preview: string) => void;
  onMessage: (message: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const timerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onMessageRef = useRef(onMessage);
  onChangeRef.current = onChange;
  onMessageRef.current = onMessage;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const safeInitial = sanitizeNoteHtml(initialHtml);
    editor.innerHTML = safeInitial;
    autoLinkTextNodes(editor);
    const linked = sanitizeNoteHtml(editor.innerHTML);
    if (linked !== safeInitial) {
      editor.innerHTML = linked;
      onChangeRef.current(noteId, linked, plainTextFromHtml(linked));
    }
  }, [noteId]);

  const flushEditor = (linkify = false) => {
    const editor = editorRef.current;
    if (!editor || !dirtyRef.current) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (linkify) autoLinkTextNodes(editor);
    const safeHtml = sanitizeNoteHtml(editor.innerHTML);
    if (safeHtml !== editor.innerHTML) editor.innerHTML = safeHtml;
    dirtyRef.current = false;
    onChangeRef.current(noteId, safeHtml, plainTextFromHtml(safeHtml));
  };
  const flushRef = useRef(flushEditor);
  flushRef.current = flushEditor;

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushRef.current(true);
    };
    window.addEventListener("pagehide", flushWhenHidden);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushWhenHidden);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      flushRef.current(false);
    };
  }, []);

  const scheduleEditorChange = () => {
    dirtyRef.current = true;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => flushRef.current(false), 420);
  };

  const saveSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (editor && selection?.rangeCount && editor.contains(selection.anchorNode)) {
      selectionRef.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const getInsertionRange = () => {
    const editor = editorRef.current;
    if (!editor) return null;
    editor.focus();
    const selection = window.getSelection();
    let range = selectionRef.current;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(range);
    selectionRef.current = range.cloneRange();
    return range;
  };

  const insertNode = (node: Node) => {
    const editor = editorRef.current;
    const range = getInsertionRange();
    const selection = window.getSelection();
    if (!editor || !range || !selection) return;
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    selectionRef.current = range.cloneRange();
    scheduleEditorChange();
  };

  const insertHtml = (html: string) => {
    const safeHtml = sanitizeNoteHtml(html);
    if (!safeHtml) return;
    const temporary = document.createElement("div");
    temporary.innerHTML = safeHtml;
    const range = getInsertionRange();
    const selection = window.getSelection();
    if (!range || !selection) return;
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    while (temporary.firstChild) fragment.appendChild(temporary.firstChild);
    const last = fragment.lastChild;
    if (!last) return;
    range.insertNode(fragment);
    range.setStartAfter(last);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    scheduleEditorChange();
  };

  const runCommand = (command: EditorCommand, value?: string) => {
    getInsertionRange();
    document.execCommand(command, false, value);
    scheduleEditorChange();
    saveSelection();
  };

  const insertLink = () => {
    const entered = window.prompt("Paste or type a web address");
    if (!entered) return;
    const href = safeLink(entered);
    if (!href) {
      onMessageRef.current("Use a valid http, https or email link.");
      return;
    }
    const editor = editorRef.current;
    const range = getInsertionRange();
    const selection = window.getSelection();
    if (!editor || !range || !selection) return;
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    if (range.collapsed) anchor.textContent = entered.trim();
    else anchor.appendChild(range.extractContents());
    range.insertNode(anchor);
    range.setStartAfter(anchor);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    scheduleEditorChange();
  };

  const insertImageData = (data: string, alt: string) => {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = data;
    image.alt = alt.slice(0, 200) || "Inserted picture";
    figure.appendChild(image);
    insertNode(figure);
  };

  const insertImageFile = async (file: File) => {
    try {
      const data = await imageFileToDataUrl(file);
      insertImageData(data, file.name.replace(/\.[^.]+$/, ""));
      onMessageRef.current("");
    } catch (error) {
      onMessageRef.current(error instanceof Error ? error.message : "Could not add that image.");
    }
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageFile = Array.from(event.clipboardData.items)
      .find((item) => item.type.startsWith("image/"))
      ?.getAsFile();
    if (imageFile) {
      event.preventDefault();
      saveSelection();
      void insertImageFile(imageFile);
      return;
    }
    const html = event.clipboardData.getData("text/html");
    if (html) {
      event.preventDefault();
      insertHtml(html);
    }
  };

  const chooseImage = () => {
    saveSelection();
    imageInputRef.current?.click();
  };

  const fontFamily = FONT_OPTIONS.find((item) => item.id === font)?.family ?? FONT_OPTIONS[0].family;

  return (
    <>
      <div className="note-toolbar" role="toolbar" aria-label="Note formatting">
        <div className="note-toolbar-group">
          <ToolButton label="Bold" mark={<b>B</b>} onRun={() => runCommand("bold")} onMouseDown={saveSelection} />
          <ToolButton label="Italic" mark={<i>I</i>} onRun={() => runCommand("italic")} onMouseDown={saveSelection} />
          <ToolButton label="Underline" mark={<u>U</u>} onRun={() => runCommand("underline")} onMouseDown={saveSelection} />
          <span className="note-tool-divider" aria-hidden="true" />
          <ToolButton label="Heading" mark="H2" onRun={() => runCommand("formatBlock", "h2")} onMouseDown={saveSelection} />
          <ToolButton label="Bulleted list" mark="•" onRun={() => runCommand("insertUnorderedList")} onMouseDown={saveSelection} />
          <ToolButton label="Numbered list" mark="1." onRun={() => runCommand("insertOrderedList")} onMouseDown={saveSelection} />
          <ToolButton label="Quote" mark="❝" onRun={() => runCommand("formatBlock", "blockquote")} onMouseDown={saveSelection} />
          <span className="note-tool-divider" aria-hidden="true" />
          <ToolButton label="Insert link" mark="↗" onRun={insertLink} onMouseDown={saveSelection} />
          <ToolButton label="Insert picture" mark="▧" onRun={chooseImage} onMouseDown={saveSelection} />
          <ToolButton label="Undo" mark="↶" onRun={() => runCommand("undo")} onMouseDown={saveSelection} />
          <ToolButton label="Redo" mark="↷" onRun={() => runCommand("redo")} onMouseDown={saveSelection} />
        </div>
        <input
          ref={imageInputRef}
          className="note-image-input"
          type="file"
          accept="image/*"
          aria-label="Choose a picture to insert"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void insertImageFile(file);
          }}
        />
      </div>
      <div
        ref={editorRef}
        className="note-editor-content"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Note content"
        aria-multiline="true"
        data-placeholder="Write something worth remembering… Paste a link or drop in a picture."
        style={{ "--note-font-family": fontFamily } as React.CSSProperties}
        onInput={scheduleEditorChange}
        onBlur={() => flushRef.current(true)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            insertLink();
          }
        }}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onPaste={handlePaste}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
          if (files.length) {
            event.preventDefault();
            saveSelection();
            for (const file of files.slice(0, 4)) void insertImageFile(file);
            return;
          }
          const html = event.dataTransfer.getData("text/html");
          if (html) {
            event.preventDefault();
            insertHtml(html);
          }
        }}
      />
    </>
  );
}

function ToolButton({
  label,
  mark,
  onRun,
  onMouseDown,
}: {
  label: string;
  mark: React.ReactNode;
  onRun: () => void;
  onMouseDown: () => void;
}) {
  return (
    <button
      type="button"
      className="note-tool-button"
      title={label}
      aria-label={label}
      onMouseDown={(event) => { event.preventDefault(); onMouseDown(); }}
      onClick={onRun}
    >
      {mark}
    </button>
  );
}

function NotesNotebook({
  legacyText,
  onLegacyConsumed,
}: {
  legacyText: string;
  onLegacyConsumed: () => void;
}) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [activeNote, setActiveNote] = useState<NotebookNote | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingNote, setLoadingNote] = useState(false);
  const [saveStatus, setSaveStatus] = useState("Saved locally");
  const [notice, setNotice] = useState("");
  const [storageAvailable, setStorageAvailable] = useState(true);
  const notesRef = useRef(notes);
  const activeNoteRef = useRef(activeNote);
  const workingNoteRef = useRef<NotebookNote | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const loadTokenRef = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const legacyTextRef = useRef(legacyText);
  const onLegacyConsumedRef = useRef(onLegacyConsumed);
  notesRef.current = notes;
  activeNoteRef.current = activeNote;
  legacyTextRef.current = legacyText;
  onLegacyConsumedRef.current = onLegacyConsumed;

  const orderedNotes = useMemo(() => sortNotes(notes), [notes]);
  const filteredNotes = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return orderedNotes;
    return orderedNotes.filter((note) => `${note.title} ${note.preview}`.toLocaleLowerCase().includes(query));
  }, [orderedNotes, search]);

  const replaceSummary = (summary: NoteSummary) => {
    const next = sortNotes([...notesRef.current.filter((note) => note.id !== summary.id), summary]);
    notesRef.current = next;
    if (mountedRef.current) setNotes(next);
  };

  const flushPendingSave = async () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!dirtyRef.current || !workingNoteRef.current) return;
    dirtyRef.current = false;
    const working = workingNoteRef.current;
    const content = sanitizeNoteHtml(working.content);
    const note: NotebookNote = {
      ...working,
      content,
      preview: plainTextFromHtml(content),
      updatedAt: Date.now(),
    };
    workingNoteRef.current = note;
    replaceSummary(toSummary(note));
    if (mountedRef.current && activeNoteRef.current?.id === note.id) {
      activeNoteRef.current = note;
      setActiveNote(note);
      setSaveStatus("Saving…");
    }
    if (!storageAvailable) {
      if (mountedRef.current) setSaveStatus("Storage unavailable");
      return;
    }
    try {
      await writeNotebookNote(note);
      if (mountedRef.current && !dirtyRef.current) setSaveStatus("Saved locally");
    } catch (error) {
      dirtyRef.current = true;
      if (mountedRef.current) {
        setStorageAvailable(false);
        setSaveStatus("Save failed");
        setNotice(error instanceof Error ? error.message : "Could not save this note locally.");
      }
    }
  };
  flushRef.current = flushPendingSave;

  const scheduleSave = () => {
    dirtyRef.current = true;
    if (mountedRef.current) setSaveStatus("Saving…");
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flushRef.current(); }, SAVE_DELAY);
  };

  const handleEditorChange = (id: string, content: string, preview: string) => {
    const current = workingNoteRef.current;
    if (!current || current.id !== id) return;
    const next = { ...current, content, preview, updatedAt: Date.now() };
    workingNoteRef.current = next;
    const persistImmediately = !mountedRef.current || document.visibilityState === "hidden";
    if (persistImmediately) {
      const safeContent = sanitizeNoteHtml(content);
      const safeNote = { ...next, content: safeContent, preview: plainTextFromHtml(safeContent) };
      workingNoteRef.current = safeNote;
      dirtyRef.current = false;
      if (mountedRef.current) {
        activeNoteRef.current = safeNote;
        setActiveNote(safeNote);
        replaceSummary(toSummary(safeNote));
      }
      if (storageAvailable) void writeNotebookNote(safeNote).catch(() => undefined);
      return;
    }
    activeNoteRef.current = next;
    setActiveNote(next);
    replaceSummary(toSummary(next));
    scheduleSave();
  };

  const updateActiveNote = (patch: Partial<Pick<NotebookNote, "title" | "font" | "pinned">>) => {
    const current = workingNoteRef.current;
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    workingNoteRef.current = next;
    activeNoteRef.current = next;
    setActiveNote(next);
    replaceSummary(toSummary(next));
    scheduleSave();
  };

  const activateNote = async (id: string, token = ++loadTokenRef.current) => {
    if (activeNoteRef.current?.id === id) return;
    await flushRef.current();
    if (token !== loadTokenRef.current) return;
    setLoadingNote(true);
    workingNoteRef.current = null;
    activeNoteRef.current = null;
    setActiveNote(null);
    try {
      const note = await readNotebookNote(id);
      if (token !== loadTokenRef.current || !mountedRef.current) return;
      if (!note) {
        setNotice("That note could not be found in local storage.");
        setLoadingNote(false);
        return;
      }
      workingNoteRef.current = { ...note, content: sanitizeNoteHtml(note.content) };
      activeNoteRef.current = workingNoteRef.current;
      setActiveNote(workingNoteRef.current);
      setLoadingNote(false);
      setNotice("");
    } catch (error) {
      if (token !== loadTokenRef.current || !mountedRef.current) return;
      setLoadingNote(false);
      setStorageAvailable(false);
      setNotice(error instanceof Error ? error.message : "Could not open this note.");
    }
  };

  const createNote = async () => {
    await flushRef.current();
    const note = newNotebookNote();
    const nextNotes = sortNotes([toSummary(note), ...notesRef.current]);
    notesRef.current = nextNotes;
    workingNoteRef.current = note;
    activeNoteRef.current = note;
    setNotes(nextNotes);
    setActiveNote(note);
    setSearch("");
    setNotice("");
    dirtyRef.current = false;
    setSaveStatus("Saving…");
    if (!storageAvailable) {
      setSaveStatus("Storage unavailable");
      return;
    }
    try {
      await writeNotebookNote(note);
      if (mountedRef.current) setSaveStatus("Saved locally");
    } catch (error) {
      if (mountedRef.current) {
        setStorageAvailable(false);
        setSaveStatus("Save failed");
        setNotice(error instanceof Error ? error.message : "Could not create a note in local storage.");
      }
    }
  };

  const deleteActiveNote = async () => {
    const note = workingNoteRef.current;
    if (!note || !window.confirm(`Delete “${note.title || "Untitled note"}”? This cannot be undone.`)) return;
    await flushRef.current();
    try {
      if (storageAvailable) await removeNotebookNote(note.id);
      const remaining = notesRef.current.filter((item) => item.id !== note.id);
      notesRef.current = sortNotes(remaining);
      setNotes(notesRef.current);
      workingNoteRef.current = null;
      activeNoteRef.current = null;
      setActiveNote(null);
      setNotice("");
      const next = sortNotes(remaining)[0];
      if (next) await activateNote(next.id);
      else setSaveStatus(storageAvailable ? "Saved locally" : "Storage unavailable");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not delete this note.");
    }
  };

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushRef.current();
    };
    window.addEventListener("pagehide", flushWhenHidden);
    document.addEventListener("visibilitychange", flushWhenHidden);
    const initialize = async () => {
      try {
        let summaries = await listNoteSummaries();
        const legacy = legacyTextRef.current;
        if (legacy.trim() && !summaries.some((note) => note.id === LEGACY_NOTE_ID)) {
          const imported: NotebookNote = {
            ...newNotebookNote("Imported memo", LEGACY_NOTE_ID),
            content: legacyTextToHtml(legacy),
          };
          imported.preview = plainTextFromHtml(imported.content);
          await writeNotebookNote(imported);
          summaries = [...summaries, toSummary(imported)];
          if (!cancelled) onLegacyConsumedRef.current();
        } else if (legacy.trim() && !cancelled) {
          onLegacyConsumedRef.current();
        }
        if (cancelled) return;
        setStorageAvailable(true);
        const ordered = sortNotes(summaries);
        notesRef.current = ordered;
        setNotes(ordered);
        if (ordered.length) {
          const first = await readNotebookNote(ordered[0].id);
          if (cancelled) return;
          if (first) {
            const clean = { ...first, content: sanitizeNoteHtml(first.content) };
            workingNoteRef.current = clean;
            activeNoteRef.current = clean;
            setActiveNote(clean);
          }
        }
      } catch (error) {
        if (cancelled) return;
        setStorageAvailable(false);
        setSaveStatus("Storage unavailable");
        setNotice(error instanceof Error ? error.message : "Local notebook storage is unavailable.");
        const legacy = legacyTextRef.current;
        if (legacy.trim()) {
          const fallback: NotebookNote = {
            ...newNotebookNote("Imported memo", "legacy-memory-note"),
            content: legacyTextToHtml(legacy),
          };
          fallback.preview = plainTextFromHtml(fallback.content);
          notesRef.current = [toSummary(fallback)];
          workingNoteRef.current = fallback;
          activeNoteRef.current = fallback;
          setNotes(notesRef.current);
          setActiveNote(fallback);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      window.removeEventListener("pagehide", flushWhenHidden);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      void flushRef.current();
    };
  }, []);

  const wordCount = activeNote?.preview ? activeNote.preview.split(/\s+/).length : 0;

  return (
    <section className="notes-notebook" aria-label="Notebook">
      <aside className="notes-sidebar">
        <div className="notes-sidebar-heading">
          <div>
            <strong>Notebook</strong>
            <small>{notes.length} {notes.length === 1 ? "note" : "notes"}</small>
          </div>
          <button type="button" className="notes-new-button" onClick={() => void createNote()} disabled={loading || loadingNote} aria-label="Create a new note" title="New note">
            <span aria-hidden="true">+</span> New
          </button>
        </div>
        <label className="notes-search-wrap">
          <span className="sr-only">Search notes</span>
          <input className="notes-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes…" />
        </label>
        <div className="notes-list" role="group" aria-label="Your notes">
          {loading && <p className="notes-list-hint">Loading notebook…</p>}
          {!loading && filteredNotes.length === 0 && <p className="notes-list-hint">{search ? "No matching notes." : "Your notes will appear here."}</p>}
          {filteredNotes.map((note) => (
            <button
              type="button"
              key={note.id}
              className={`notes-list-item ${activeNote?.id === note.id ? "active" : ""}`}
              aria-pressed={activeNote?.id === note.id}
              onClick={() => void activateNote(note.id)}
            >
              <span className="notes-list-item-top">
                <strong>{note.title.trim() || "Untitled note"}</strong>
                {note.pinned && <span className="notes-pin-mark" aria-label="Pinned">◆</span>}
              </span>
              <span className="notes-list-preview">{note.preview || "No text yet"}</span>
              <small>{formatUpdatedAt(note.updatedAt)}</small>
            </button>
          ))}
        </div>
      </aside>

      <div className={`notes-editor ${!activeNote ? "is-empty" : ""}`}>
        {loading || loadingNote ? (
          <div className="notes-empty-state"><span className="notes-empty-icon">✎</span><strong>Opening your notebook…</strong></div>
        ) : activeNote ? (
          <>
            <div className="notes-editor-heading">
              <input
                className="notes-title-input"
                aria-label="Note title"
                value={activeNote.title}
                maxLength={100}
                onChange={(event) => updateActiveNote({ title: event.target.value })}
                placeholder="Untitled note"
              />
              <div className="notes-editor-actions">
                <button type="button" className={`notes-icon-button ${activeNote.pinned ? "is-pinned" : ""}`} onClick={() => updateActiveNote({ pinned: !activeNote.pinned })} aria-pressed={activeNote.pinned} aria-label={activeNote.pinned ? "Unpin note" : "Pin note"} title={activeNote.pinned ? "Unpin note" : "Pin note"}>◆</button>
                <button type="button" className="notes-icon-button is-danger" onClick={() => void deleteActiveNote()} aria-label="Delete note" title="Delete note">×</button>
              </div>
            </div>
            <div className="notes-tools-row">
              <label className="notes-font-picker">
                <span>Font</span>
                <select aria-label="Note font" value={activeNote.font} onChange={(event) => updateActiveNote({ font: event.target.value as NoteFont })}>
                  {FONT_OPTIONS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
                </select>
              </label>
              <span className="notes-last-edited">{wordCount} {wordCount === 1 ? "word" : "words"} · {formatUpdatedAt(activeNote.updatedAt)}</span>
            </div>
            <RichEditor
              key={activeNote.id}
              noteId={activeNote.id}
              initialHtml={activeNote.content}
              font={activeNote.font}
              onChange={handleEditorChange}
              onMessage={setNotice}
            />
            <div className="notes-save-line" role="status" aria-live="polite">
              <span className={`notes-save-dot ${saveStatus === "Saved locally" ? "is-saved" : ""}`} />
              <span>{notice || saveStatus}</span>
              <span className="notes-save-location">Private to this device</span>
            </div>
          </>
        ) : (
          <div className="notes-empty-state">
            <span className="notes-empty-icon">✎</span>
            <strong>{notes.length ? "Choose a note" : "Make room for a thought"}</strong>
            <p>{notes.length ? "Pick one from the notebook or create another." : "Write a memo, save a useful link, or collect an image."}</p>
            {!notes.length && <button type="button" className="notes-new-button" onClick={() => void createNote()} disabled={loading}>Create your first note</button>}
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(NotesNotebook);
