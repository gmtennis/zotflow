// Hover preview of obsidian://zotflow links: Obsidian's hover popover with
// the linked PDF page, driven with real mouse input in a note.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

import { inObsidian, intercept, requests, stopIntercepting } from "../sync/lib.mjs";
import { focusMainWindow, key, LIBRARY_ID, openReader, reset, session as connect, until } from "./lib.mjs";

const NOTE = "ZotFlow link preview.md";
const annotationLink = (id) => `obsidian://zotflow?type=open-annotation&libraryID=${LIBRARY_ID}&key=${key(id)}`;
const pageLink = (p) =>
    `obsidian://zotflow?type=open-attachment&libraryID=${LIBRARY_ID}&key=${key("attention-pdf")}&page=${p}`;
// The link sits below the first line: Live Preview shows the raw markdown
// on the line with the cursor, which starts on line 1.
const note = (text, href) => `# Links\n\nSee [${text}](${href}) here.\n`;

let session;
before(async () => {
    session = await connect();
});
beforeEach(async () => {
    await reset();
    // The preview only reads the PDF from this device: open it once so the
    // attachment cache holds it.
    await openReader(session.page, key("attention-pdf"));
});

/** Open the note in a fresh tab, in reading view or Live Preview. */
async function openNote(page, text, mode) {
    await focusMainWindow(page);
    await page.evaluate(
        async ({ path, text, mode }) => {
            const { vault, workspace } = window.app;
            const existing = vault.getFileByPath(path);
            const file = existing ?? (await vault.create(path, text));
            if (existing) await vault.modify(file, text);
            const leaf = workspace.getLeaf("tab");
            await leaf.openFile(file, { state: { mode, source: false } });
            workspace.setActiveLeaf(leaf, { focus: true });
        },
        { path: NOTE, text, mode },
    );
}

const leaf = (page) => page.locator(".workspace-leaf.mod-active");
const popover = (page) => page.locator(".popover.hover-popover");
const pageCanvas = (page) => popover(page).locator("canvas.zotflow-link-preview-page");

/** Move the pointer off the link and wait until the popover is gone. */
async function leave(page) {
    await page.mouse.move(5, 5);
    await until(async () => (await popover(page).count()) === 0, { message: "popover closed" });
}

describe("zotflow link hover preview", () => {
    test("reading view: an annotation link shows its page with the annotation marked", async () => {
        const { page } = session;
        await openNote(page, note("underline", annotationLink("attention-pdf-underline")), "preview");
        await leaf(page).locator(".markdown-reading-view a.external-link").first().hover();

        await pageCanvas(page).waitFor();
        // The underline is on the second page.
        assert.equal(await pageCanvas(page).getAttribute("data-page-index"), "1");
        assert.equal(await pageCanvas(page).getAttribute("data-marks"), "1");
        await leave(page);
    });

    test("the preview stays open on the link, also after the pointer only passed over it", async () => {
        const { page } = session;
        await openNote(page, note("underline", annotationLink("attention-pdf-underline")), "preview");
        const link = leaf(page).locator(".markdown-reading-view a.external-link").first();

        // Passing over the link quicker than the hover delay opens nothing...
        await link.hover();
        await page.mouse.move(5, 5);
        await page.waitForTimeout(600);
        assert.equal(await popover(page).count(), 0);

        // ...and must not keep the next hover from opening the preview.
        for (let i = 0; i < 3; i++) {
            await link.hover();
            await pageCanvas(page).waitFor();
            // Obsidian closes a popover whose pointer it lost; resting on the
            // link keeps it open.
            await page.waitForTimeout(1500);
            assert.equal(await pageCanvas(page).count(), 1, `still open on hover ${i + 1}`);
            await leave(page);
        }
    });

    test("Live Preview: a page link shows that page", async () => {
        const { page } = session;
        await openNote(page, note("p. 2", pageLink("2")), "source");
        await leaf(page).locator(".cm-content .cm-link", { hasText: "p. 2" }).first().hover();

        await pageCanvas(page).waitFor();
        assert.equal(await pageCanvas(page).getAttribute("data-page-index"), "1");
        assert.equal(await pageCanvas(page).getAttribute("data-marks"), "0");
        await leave(page);
    });

    test("without a local PDF: the annotation's text and comment, and no request", async () => {
        const { page } = session;
        await inObsidian((t) => t.bridge.attachment.purgeCache());
        await openNote(page, note("underline", annotationLink("attention-pdf-underline")), "preview");
        await intercept();
        try {
            await leaf(page).locator(".markdown-reading-view a.external-link").first().hover();
            await popover(page).locator(".zotflow-link-preview-text").waitFor();

            assert.match(await popover(page).innerText(), /Scaled Dot-Product Attention/);
            assert.match(await popover(page).innerText(), /Multi-line/);
            assert.equal(await pageCanvas(page).count(), 0);
            assert.deepEqual(await requests(), []);
        } finally {
            await stopIntercepting();
        }
        await leave(page);
    });
});
