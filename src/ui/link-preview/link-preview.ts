/**
 * Hover preview for `obsidian://zotflow` links: a popover with the PDF page
 * the link opens, the linked annotation (or selection) marked on it.
 *
 * Obsidian's Page Preview only handles internal links, so this listens for
 * `mouseover` itself and shows Obsidian's own `HoverPopover` (same delay,
 * same closing when the pointer leaves). Reading view and rendered widgets
 * in Live Preview (callouts) carry the URL as an `href`; inline links in
 * Live Preview are read from the editor's source text.
 *
 * The page comes from this device only (`getLocalFileBlob`): no network
 * request on hover. Without a local copy, an annotation link shows the
 * annotation's text and comment from the database instead.
 */

import { EditorView } from "@codemirror/view";
import { HoverPopover, loadPdfJs } from "obsidian";

import { workerBridge } from "bridge";
import { services } from "services/services";
import {
    findMarkdownLinkAt,
    parsePreviewTarget,
    positionRects,
    resolvePageIndex,
} from "ui/link-preview/link-target";

import type { HoverParent, Plugin } from "obsidian";
import type { PageRef } from "ui/link-preview/link-target";

/** Rendered page width in CSS pixels (the popover's content width). */
const PAGE_WIDTH = 450;

/* The part of PDF.js used here (Obsidian's copy, via loadPdfJs). */
interface PdfViewport {
    width: number;
    height: number;
    convertToViewportRectangle(rect: number[]): number[];
}
interface PdfPage {
    getViewport(options: { scale: number }): PdfViewport;
    render(options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: PdfViewport;
    }): { promise: Promise<void>; cancel(): void };
}
interface PdfDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPage>;
    getPageLabels(): Promise<string[] | null>;
}
interface PdfLoadingTask {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
}
interface PdfJs {
    getDocument(source: { data: Uint8Array }): PdfLoadingTask;
}

/** What to draw: a page of an attachment, and what to mark on it. */
interface PagePreview {
    libraryID: number;
    attachmentKey: string;
    page: PageRef;
    rects: number[][];
    color?: string;
    /** Annotation text and comment, for the fallback without a PDF. */
    text?: string;
    comment?: string;
}

export function registerLinkPreview(plugin: Plugin): void {
    const parent: HoverParent = { hoverPopover: null };
    let current: { el: HTMLElement; popover: HoverPopover } | null = null;

    plugin.registerDomEvent(document, "mouseover", (evt) => {
        const link = findLink(evt.target);
        if (!link || current?.el === link.el) return;
        const target = parsePreviewTarget(link.href);
        if (!target) return;

        const popover = new HoverPopover(parent, link.el);
        // A popover loads only when shown, and unload() skips a component
        // that never loaded: one hidden before its delay ran out (the
        // pointer only passed over the link) would never run the cleanup
        // below. Load it now so every hide() does.
        popover.load();
        const entry = { el: link.el, popover };
        current = entry;
        let closed = false;
        popover.register(() => {
            closed = true;
            if (current === entry) current = null;
        });

        void (async () => {
            const preview: PagePreview | null =
                target.kind === "annotation"
                    ? await annotationPreview(target.libraryID, target.key)
                    : {
                          libraryID: target.libraryID,
                          attachmentKey: target.key,
                          page: target.page,
                          rects: target.rects,
                      };
            if (closed) return;
            if (!preview) {
                popover.hide();
                return;
            }
            await renderPreview(popover, preview, () => closed);
        })().catch((e: unknown) => {
            // Closing the popover cancels the render: not an error.
            if (closed) return;
            services.logService.error("Link preview failed", "LinkPreview", e);
            popover.hide();
        });
    });
}

/** The zotflow link under the pointer and its URL, or null. */
function findLink(
    target: EventTarget | null,
): { el: HTMLElement; href: string } | null {
    if (!(target instanceof HTMLElement)) return null;

    const anchor = target.closest<HTMLAnchorElement>(
        'a[href^="obsidian://zotflow?"]',
    );
    if (anchor) return { el: anchor, href: anchor.getAttribute("href")! };

    // Live Preview: `[text](url)` is shown as text without an href.
    const span = target.closest<HTMLElement>(".cm-link, .cm-url");
    if (!span) return null;
    const view = EditorView.findFromDOM(span);
    if (!view) return null;
    const pos = view.posAtDOM(span);
    const line = view.state.doc.lineAt(pos);
    const href = findMarkdownLinkAt(line.text, pos - line.from);
    return href ? { el: span, href } : null;
}

/** An annotation's page, rects and text, from the local database. */
async function annotationPreview(
    libraryID: number,
    key: string,
): Promise<PagePreview | null> {
    const item = await workerBridge.dbHelper.getItem(libraryID, key);
    if (!item || item.itemType !== "annotation" || !item.parentItem) {
        return null;
    }
    const data = item.raw.data as unknown as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);

    let position: { pageIndex?: unknown } | null = null;
    try {
        position = JSON.parse(str(data.annotationPosition) ?? "null") as {
            pageIndex?: unknown;
        } | null;
    } catch {
        // Unreadable position: show the text only.
    }
    return {
        libraryID,
        attachmentKey: item.parentItem,
        page:
            typeof position?.pageIndex === "number"
                ? { pageIndex: position.pageIndex }
                : null,
        rects: positionRects(position),
        color: str(data.annotationColor),
        text: str(data.annotationText),
        comment: str(data.annotationComment),
    };
}

async function renderPreview(
    popover: HoverPopover,
    preview: PagePreview,
    isClosed: () => boolean,
): Promise<void> {
    const container = popover.hoverEl.createDiv({
        cls: "zotflow-link-preview",
    });

    const blob = await workerBridge.attachment.getLocalFileBlob(
        preview.libraryID,
        preview.attachmentKey,
    );
    if (isClosed()) return;
    if (!blob) {
        renderText(container, preview, "PDF not available on this device.");
        return;
    }
    if (blob.type !== "application/pdf") {
        renderText(container, preview, "No page preview for this file type.");
        return;
    }

    const data = new Uint8Array(await blob.arrayBuffer());
    const pdfjs = (await loadPdfJs()) as PdfJs;
    // No await between this check and register(): a popover closed in
    // between would never free the document.
    if (isClosed()) return;
    const task = pdfjs.getDocument({ data });
    // Free the document (and PDF.js's worker side of it) with the popover.
    popover.register(() => void task.destroy());
    const doc = await task.promise;
    if (isClosed()) return;

    const pageIndex = resolvePageIndex(
        preview.page,
        await doc.getPageLabels(),
        doc.numPages,
    );
    if (isClosed()) return;
    if (pageIndex === null) {
        renderText(container, preview, "Page not found in this PDF.");
        return;
    }

    const page = await doc.getPage(pageIndex + 1);
    if (isClosed()) return;
    const scale = PAGE_WIDTH / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({
        scale: scale * window.devicePixelRatio,
    });
    const canvas = container.createEl("canvas", {
        cls: "zotflow-link-preview-page",
        attr: {
            width: Math.floor(viewport.width),
            height: Math.floor(viewport.height),
            "data-page-index": pageIndex,
            "data-marks": preview.rects.length,
        },
    });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const render = page.render({ canvasContext: ctx, viewport });
    popover.register(() => render.cancel());
    await render.promise;
    if (isClosed()) return;

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = preview.color || "#ffd400";
    let top = Infinity;
    for (const rect of preview.rects) {
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] =
            viewport.convertToViewportRectangle(rect);
        top = Math.min(top, y1, y2);
        ctx.fillRect(
            Math.min(x1, x2),
            Math.min(y1, y2),
            Math.abs(x2 - x1),
            Math.abs(y2 - y1),
        );
    }
    // The popover shows part of the page: bring the mark into view. The
    // popover is attached only once shown, so wait until it has a size.
    if (top !== Infinity) {
        const markTop = top / window.devicePixelRatio;
        const observer = new ResizeObserver(() => {
            if (container.clientHeight === 0) return;
            container.scrollTop = Math.max(
                0,
                markTop - container.clientHeight / 3,
            );
            observer.disconnect();
        });
        observer.observe(container);
        popover.register(() => observer.disconnect());
    }
}

/** The annotation as text, when its page cannot be drawn. */
function renderText(
    container: HTMLElement,
    preview: PagePreview,
    note: string,
): void {
    if (preview.text) {
        container.createEl("blockquote", {
            cls: "zotflow-link-preview-text",
            text: preview.text,
        });
    }
    if (preview.comment) {
        container.createDiv({
            cls: "zotflow-link-preview-comment",
            text: preview.comment,
        });
    }
    container.createDiv({ cls: "zotflow-link-preview-note", text: note });
}
