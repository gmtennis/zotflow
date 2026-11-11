import { describe, expect, it } from "vitest";

import {
    findMarkdownLinkAt,
    parsePreviewTarget,
    resolvePageIndex,
    positionRects,
} from "ui/link-preview/link-target";

const nav = (o: object) => encodeURIComponent(JSON.stringify(o));
const zf = (q: string) => `obsidian://zotflow?${q}`;

describe("parsePreviewTarget", () => {
    it("reads an annotation link", () => {
        expect(
            parsePreviewTarget(
                zf("type=open-annotation&libraryID=7&key=ANNO1"),
            ),
        ).toEqual({ kind: "annotation", libraryID: 7, key: "ANNO1" });
    });

    it("reads an attachment link with &page=", () => {
        expect(
            parsePreviewTarget(
                zf("type=open-attachment&libraryID=7&key=ATT1&page=iv"),
            ),
        ).toEqual({
            kind: "attachment",
            libraryID: 7,
            key: "ATT1",
            page: { pageNumber: "iv" },
            rects: [],
        });
    });

    it("reads a position navigation (Copy Link to Selection)", () => {
        const position = { pageIndex: 3, rects: [[1, 2, 3, 4]] };
        expect(
            parsePreviewTarget(
                zf(
                    `type=open-attachment&libraryID=7&key=ATT1&navigation=${nav({ position })}`,
                ),
            ),
        ).toEqual({
            kind: "attachment",
            libraryID: 7,
            key: "ATT1",
            page: { pageIndex: 3 },
            rects: [[1, 2, 3, 4]],
        });
    });

    it("lets navigation win over &page=, like the protocol handler", () => {
        const target = parsePreviewTarget(
            zf(
                `type=open-attachment&libraryID=7&key=ATT1&page=9&navigation=${nav({ pageIndex: 2 })}`,
            ),
        );
        expect(target).toMatchObject({ page: { pageIndex: 2 } });
    });

    it("treats an annotationID navigation as an annotation link", () => {
        expect(
            parsePreviewTarget(
                zf(
                    `type=open-attachment&libraryID=7&key=ATT1&navigation=${nav({ annotationID: "ANNO1" })}`,
                ),
            ),
        ).toEqual({ kind: "annotation", libraryID: 7, key: "ANNO1" });
    });

    it("reads pageLabel and pageIndex navigations", () => {
        expect(
            parsePreviewTarget(
                zf(
                    `type=open-attachment&libraryID=7&key=ATT1&navigation=${nav({ pageLabel: "12" })}`,
                ),
            ),
        ).toMatchObject({ page: { pageLabel: "12" } });
        expect(
            parsePreviewTarget(
                zf(
                    `type=open-attachment&libraryID=7&key=ATT1&navigation=${nav({ pageIndex: 0 })}`,
                ),
            ),
        ).toMatchObject({ page: { pageIndex: 0 } });
    });

    it("previews an attachment link without a page at its first page", () => {
        expect(
            parsePreviewTarget(zf("type=open-attachment&libraryID=7&key=ATT1")),
        ).toMatchObject({ page: null });
    });

    it("ignores links it cannot preview", () => {
        for (const href of [
            zf("type=open-note&libraryID=7&key=ITEM1"),
            zf("type=open-attachment&libraryID=x&key=ATT1"),
            zf("type=open-attachment&libraryID=7"),
            zf(
                "type=open-attachment&libraryID=7&key=ATT1&navigation=%7Bbroken",
            ),
            "obsidian://open?vault=x",
            "https://example.com",
        ]) {
            expect(parsePreviewTarget(href)).toBeNull();
        }
    });
});

describe("resolvePageIndex", () => {
    const labels = ["i", "ii", "1", "2", "3"];

    it("defaults to the first page", () => {
        expect(resolvePageIndex(null, labels, 5)).toBe(0);
    });

    it("takes a page index as is, within the document", () => {
        expect(resolvePageIndex({ pageIndex: 4 }, labels, 5)).toBe(4);
        expect(resolvePageIndex({ pageIndex: 5 }, labels, 5)).toBeNull();
    });

    it("matches a page label exactly", () => {
        expect(resolvePageIndex({ pageLabel: "ii" }, labels, 5)).toBe(1);
        expect(resolvePageIndex({ pageLabel: "9" }, labels, 5)).toBeNull();
    });

    it("prefers the label for a page number, else counts from 1", () => {
        // Same rule as the reader's pageNumber navigation.
        expect(resolvePageIndex({ pageNumber: "1" }, labels, 5)).toBe(2);
        expect(resolvePageIndex({ pageNumber: "5" }, labels, 5)).toBe(4);
        expect(resolvePageIndex({ pageNumber: "5" }, null, 5)).toBe(4);
        expect(resolvePageIndex({ pageNumber: "6" }, null, 5)).toBeNull();
        expect(resolvePageIndex({ pageNumber: "x" }, null, 5)).toBeNull();
    });
});

describe("positionRects", () => {
    it("uses the rects of a highlight", () => {
        expect(positionRects({ pageIndex: 0, rects: [[1, 2, 3, 4]] })).toEqual([
            [1, 2, 3, 4],
        ]);
    });

    it("boxes the paths of an ink annotation", () => {
        expect(
            positionRects({
                pageIndex: 0,
                paths: [
                    [10, 20, 30, 5],
                    [15, 40],
                ],
            }),
        ).toEqual([[10, 5, 30, 40]]);
    });

    it("has nothing to mark for an unknown shape", () => {
        expect(positionRects({ pageIndex: 0 })).toEqual([]);
        expect(positionRects(null)).toEqual([]);
    });
});

describe("findMarkdownLinkAt", () => {
    const line =
        "See [p. 2](obsidian://zotflow?type=open-attachment&libraryID=7&key=A&page=2) and [web](https://x.org).";

    it("finds the zotflow link under an offset", () => {
        expect(findMarkdownLinkAt(line, line.indexOf("p. 2"))).toBe(
            "obsidian://zotflow?type=open-attachment&libraryID=7&key=A&page=2",
        );
        expect(findMarkdownLinkAt(line, line.indexOf("page=2"))).toBe(
            "obsidian://zotflow?type=open-attachment&libraryID=7&key=A&page=2",
        );
    });

    it("finds nothing outside a zotflow link", () => {
        expect(findMarkdownLinkAt(line, 0)).toBeNull();
        expect(findMarkdownLinkAt(line, line.indexOf("web"))).toBeNull();
    });
});
