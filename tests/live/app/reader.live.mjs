// Reader: the fixture attachments in ZotFlow's embedded Zotero reader, driven
// with real mouse and keyboard input through Playwright.

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

import spec from "../../../scripts/fixture-library.mjs";
import { buildDesired } from "../../../scripts/zotero-fixtures-lib.mjs";
import { key, LIBRARY_ID, local, openReader, reset, session as connect, until } from "./lib.mjs";

const fixtures = buildDesired(spec);
const annotationsOf = (parentId) =>
    fixtures.items
        .filter((i) => i.data.itemType === "annotation" && i.data.parentItem === key(parentId))
        .map((i) => i.key)
        .sort();

let session;
before(async () => {
    session = await connect();
});
beforeEach(reset);

describe("PDF reader", () => {
    test("shows every fixture annotation in the sidebar", async () => {
        const r = await openReader(session.page, key("attention-pdf"));
        await r.showSidebar();
        const expected = annotationsOf("attention-pdf");
        await r.cards.nth(expected.length - 1).waitFor();
        assert.deepEqual((await r.annotationIds()).sort(), expected);
    });

    test("page navigation from the keyboard and toolbar", async () => {
        const r = await openReader(session.page, key("attention-pdf"));
        const pageNumber = r.reader.locator("#pageNumber");
        await pageNumber.fill("1");
        await pageNumber.press("Enter");
        await r.view.getByText("Attention Is All You Need").first().waitFor();
        await r.reader.getByTitle("Next Page").click();
        await until(async () => (await pageNumber.inputValue()) === "2", { message: "page 2" });
    });

    test("a dragged highlight is saved locally, and deleting it removes the unpushed row", async () => {
        const { page } = session;
        const r = await openReader(page, key("attention-pdf"));
        await r.reader.locator("#pageNumber").fill("1");
        await r.reader.locator("#pageNumber").press("Enter");
        await r.showSidebar();
        const fixtureIds = annotationsOf("attention-pdf");
        await r.cards.nth(fixtureIds.length - 1).waitFor();

        await r.reader.getByTitle("Highlight Text").click();
        const line = r.view.locator(".textLayer span", { hasText: "Ashish Vaswani" }).first();
        const box = await line.boundingBox();
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + 1, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.35, y, { steps: 12 });
        await page.mouse.up();

        const created = await until(
            async () => (await r.annotationIds()).find((id) => !fixtureIds.includes(id)),
            { message: "new sidebar card" },
        );
        const row = await until(() => local.row(created), { message: "IndexedDB row" });
        assert.equal(row.syncStatus, "created");
        assert.equal(row.raw.data.annotationType, "highlight");
        assert.match(row.raw.data.annotationText, /^Ashish/);

        await r.card(created).click();
        await page.keyboard.press("Delete");
        await r.card(created).waitFor({ state: "detached" });
        // Never pushed, so it is removed outright rather than queued.
        await until(async () => !(await local.row(created)), { message: "row removed" });
        for (const id of fixtureIds) {
            assert.equal((await local.row(id))?.syncStatus, "synced", id);
        }
    });
});

describe("reusing a reader leaf", () => {
    // Obsidian calls setViewState on an open view for history, layout restore
    // and links. These used to leave the reader blank: loadDocument() emptied
    // the bridge's iframe out of the view, and the bridge was never rebuilt.
    const setViewState = (page, itemKey) =>
        page.evaluate(
            async ({ libraryID, itemKey }) => {
                await window.app.workspace.activeLeaf.setViewState({
                    type: "zotflow-zotero-reader-view",
                    state: { libraryID, itemKey },
                    active: true,
                });
            },
            { libraryID: LIBRARY_ID, itemKey },
        );

    test("opening another attachment in the same leaf shows it", async () => {
        const { page } = session;
        await openReader(page, key("attention-pdf"));
        await setViewState(page, key("morphology-epub"));
        const reader = page.frameLocator(".workspace-leaf.mod-active iframe");
        await reader.frameLocator("iframe").getByText("smallest meaningful unit").first().waitFor();
        assert.equal(await page.locator(".workspace-leaf.mod-active .zotflow-loading").count(), 0);
    });

    test("setting the same attachment again keeps the loaded reader", async () => {
        const { page } = session;
        await openReader(page, key("attention-pdf"));
        const iframe = page.locator(".workspace-leaf.mod-active iframe");
        await iframe.evaluate((el) => (el.dataset.zfProbe = "first"));
        await setViewState(page, key("attention-pdf"));
        await page.waitForTimeout(1000);
        assert.equal(await iframe.getAttribute("data-zf-probe"), "first", "reader was reloaded");
        assert.equal(await page.locator(".workspace-leaf.mod-active .zotflow-loading").count(), 0);
    });
});

describe("obsidian://zotflow links", () => {
    // Call the handler the plugin registered, as Obsidian does for a clicked
    // link (minus the OS round trip and the trust prompt).
    const follow = (page, params) =>
        page.evaluate(async (p) => {
            await window.app.workspace.protocolHandler.handlers.get("zotflow")({ action: "zotflow", ...p });
        }, params);
    const activePage = (page) =>
        page.frameLocator(".workspace-leaf.mod-active iframe").locator("#pageNumber").inputValue();

    test("&page= opens the attachment at that page, in a new and in an open reader", async () => {
        const { page } = session;
        // Leave the reader on page 1, so a restored view state cannot pass for page 2.
        const r = await openReader(page, key("attention-pdf"));
        await r.reader.locator("#pageNumber").fill("1");
        await r.reader.locator("#pageNumber").press("Enter");
        await page.evaluate(() => {
            for (const l of window.app.workspace.getLeavesOfType("zotflow-zotero-reader-view")) l.detach();
        });

        const link = { type: "open-attachment", libraryID: String(LIBRARY_ID), key: key("attention-pdf") };
        await follow(page, { ...link, page: "2" });
        await until(async () => (await activePage(page)) === "2", { message: "page 2 in a new reader" });

        await follow(page, { ...link, page: "1" });
        await until(async () => (await activePage(page)) === "1", { message: "page 1 in the open reader" });
    });

    test("an annotation link still selects the annotation", async () => {
        const { page } = session;
        const r = await openReader(page, key("attention-pdf"));
        await r.showSidebar();
        const id = key("attention-pdf-underline");
        await follow(page, { type: "open-annotation", libraryID: String(LIBRARY_ID), key: id });
        await until(async () => /\bselected\b/.test((await r.card(id).getAttribute("class")) ?? ""), {
            message: "annotation selected",
        });
    });
});

describe("EPUB reader", () => {
    test("shows the fixture highlight", async () => {
        const r = await openReader(session.page, key("morphology-epub"));
        await r.showSidebar();
        await r.card(key("morphology-epub-highlight")).waitFor();
        await r.view.getByText("smallest meaningful unit").first().waitFor();
    });
});
