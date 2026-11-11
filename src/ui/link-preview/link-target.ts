/**
 * What the hover preview of an `obsidian://zotflow` link shows — pure
 * functions, kept apart from the DOM and Obsidian so they can be tested.
 *
 * The rules mirror the protocol handler (`main.ts`) and the reader's
 * `PDFView.navigate`, so the preview shows the page a click would open.
 */

/** A page as a link names it: the reader's navigation fields. */
export type PageRef =
    | { pageIndex: number }
    | { pageLabel: string }
    | { pageNumber: string }
    | null;

export type PreviewTarget =
    | { kind: "annotation"; libraryID: number; key: string }
    | {
          kind: "attachment";
          libraryID: number;
          key: string;
          /** null: the first page. */
          page: PageRef;
          /** PDF-space rectangles to mark ([x1, y1, x2, y2]). */
          rects: number[][];
      };

/** Parse a link into what to preview, or null when there is nothing to show. */
export function parsePreviewTarget(href: string): PreviewTarget | null {
    if (!href.startsWith("obsidian://zotflow?")) return null;
    const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    const type = params.get("type");
    const key = params.get("key");
    const libraryID = Number(params.get("libraryID"));
    if (!key || !Number.isInteger(libraryID)) return null;

    if (type === "open-annotation") {
        return { kind: "annotation", libraryID, key };
    }
    if (type !== "open-attachment") return null;

    const rawNavigation = params.get("navigation");
    if (rawNavigation) {
        let navigation: Record<string, unknown>;
        try {
            navigation = JSON.parse(rawNavigation) as Record<string, unknown>;
        } catch {
            return null;
        }
        if (typeof navigation.annotationID === "string") {
            return {
                kind: "annotation",
                libraryID,
                key: navigation.annotationID,
            };
        }
        const position = navigation.position as
            { pageIndex?: unknown } | undefined;
        if (typeof position?.pageIndex === "number") {
            return {
                kind: "attachment",
                libraryID,
                key,
                page: { pageIndex: position.pageIndex },
                rects: positionRects(position),
            };
        }
        return {
            kind: "attachment",
            libraryID,
            key,
            page: pageRef(navigation),
            rects: [],
        };
    }

    const page = params.get("page");
    return {
        kind: "attachment",
        libraryID,
        key,
        page: page ? { pageNumber: page } : null,
        rects: [],
    };
}

function pageRef(navigation: Record<string, unknown>): PageRef {
    const { pageIndex, pageLabel, pageNumber } = navigation;
    if (typeof pageIndex === "number") return { pageIndex };
    if (typeof pageLabel === "string") return { pageLabel };
    if (typeof pageNumber === "string" || typeof pageNumber === "number") {
        return { pageNumber: String(pageNumber) };
    }
    return null;
}

/**
 * The 0-based page a reference names, or null when the document has no
 * such page. `pageNumber` is a label first, else a 1-based number — the
 * reader's rule.
 */
export function resolvePageIndex(
    page: PageRef,
    labels: string[] | null,
    numPages: number,
): number | null {
    const inRange = (i: number) =>
        Number.isInteger(i) && i >= 0 && i < numPages ? i : null;
    if (!page) return inRange(0);
    if ("pageIndex" in page) return inRange(page.pageIndex);
    if ("pageLabel" in page) {
        return inRange(labels?.indexOf(page.pageLabel) ?? -1);
    }
    const byLabel = labels?.indexOf(page.pageNumber) ?? -1;
    if (byLabel !== -1) return byLabel;
    return /^\d+$/.test(page.pageNumber)
        ? inRange(parseInt(page.pageNumber, 10) - 1)
        : null;
}

/**
 * Rectangles to mark for an annotation position: its rects, or the
 * bounding box of an ink annotation's paths.
 */
export function positionRects(position: unknown): number[][] {
    const p = position as { rects?: unknown; paths?: unknown } | null;
    if (Array.isArray(p?.rects)) return p.rects as number[][];
    if (!Array.isArray(p?.paths)) return [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const path of p.paths as number[][]) {
        for (let i = 0; i + 1 < path.length; i += 2) {
            xs.push(path[i]!);
            ys.push(path[i + 1]!);
        }
    }
    if (xs.length === 0) return [];
    return [
        [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    ];
}

const MARKDOWN_ZOTFLOW_LINK = /\[[^\]]*\]\((obsidian:\/\/zotflow\?[^)\s]*)\)/g;

/**
 * The zotflow URL of the markdown link `[text](obsidian://zotflow?…)` that
 * covers `offset` in a line of source text, or null. Live Preview shows
 * such a link as text without an `href`, so the editor reads it here.
 */
export function findMarkdownLinkAt(
    line: string,
    offset: number,
): string | null {
    for (const m of line.matchAll(MARKDOWN_ZOTFLOW_LINK)) {
        if (offset >= m.index && offset < m.index + m[0].length) {
            return m[1] ?? null;
        }
    }
    return null;
}
