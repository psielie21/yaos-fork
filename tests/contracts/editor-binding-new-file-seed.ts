import type { MarkdownView, TFile, Workspace } from "obsidian";
import * as Y from "yjs";
import { EditorBindingManager } from "../../src/sync/editorBinding";
import type { VaultSync } from "../../src/sync/vaultSync";
import { partialOf } from "../mocks/productFixture.ts";
import { suite } from "../harness.ts";

/**
 * Regression: creating a new note in the active pane copied the previously
 * open note's text into the new note's CRDT.
 *
 * Obsidian points `view.file` at the new file before the editor has loaded
 * its (empty) content. Any bind() that ran in that window found no Y.Text for
 * the new path and seeded one from `view.editor.getValue()` — the previous
 * note. Disk then disagreed with the CRDT and reconcile minted
 * "(YAOS conflict - crdt from …)" artifacts holding the old note's text.
 */
const s = suite("editor-binding-new-file-seed");

const OLD_NOTE = "# Previously open note\n\nsecret contents\n";

function makeHarness(opts: { editor: string; disk: string; path?: string }) {
	const path = opts.path ?? "test.md";
	const texts = new Map<string, Y.Text>();
	const doc = new Y.Doc();
	const ensureCalls: Array<{ path: string; content: string }> = [];
	const vaultSync = partialOf<VaultSync>({
		getTextForPath: (p: string) => texts.get(p) ?? null,
		isMarkdownTombstoned: () => false,
		isPendingRenameTarget: () => false,
		getFileId: () => "file-id",
		getFileIdForText: () => "file-id",
		ensureFile: ((p: string, content: string) => {
			ensureCalls.push({ path: p, content });
			const t = doc.getText(p);
			t.insert(0, content);
			texts.set(p, t);
			return t;
		}) as VaultSync["ensureFile"],
	});
	const state = { editor: opts.editor, disk: opts.disk };
	const file = partialOf<TFile>({ path });
	const view = partialOf<MarkdownView>({
		file,
		leaf: { id: "leaf-1" } as MarkdownView["leaf"],
		editor: { getValue: () => state.editor } as MarkdownView["editor"],
		app: {
			vault: { read: async () => state.disk },
		} as unknown as MarkdownView["app"],
	});
	const manager = new EditorBindingManager(
		vaultSync,
		partialOf<Workspace>({ getActiveViewOfType: (() => null) as Workspace["getActiveViewOfType"] }),
		false,
	);
	const rebinds: string[] = [];
	// Isolate the seeding logic from CodeMirror plumbing.
	manager.bind = ((v: MarkdownView) => { rebinds.push(v.file?.path ?? "?"); }) as typeof manager.bind;
	return { manager, view, state, ensureCalls, texts, rebinds, path };
}

s.section("Test 1: a missing CRDT entry is never seeded from a stale editor");
{
	const h = makeHarness({ editor: OLD_NOTE, disk: "" });
	const target = h.manager["resolveBindingTarget"](h.view, "device-UniLaptop", "bind");
	s.check(
		!h.ensureCalls.some((c) => c.content === OLD_NOTE),
		"previous note's editor text is not written into the new file's CRDT",
	);
	s.check(target === null, "binding is deferred until the new file's content is known");
	h.manager.unbindAll();
}

s.section("Test 2: seeding waits for the editor to load the file, then uses disk");
{
	const h = makeHarness({ editor: OLD_NOTE, disk: "" });
	const first = await h.manager["seedFromDisk"](h.view, "device-UniLaptop", "leaf-1", h.path, "test");
	s.check(first === "retry", "editor still showing the old note -> retry, no seed");
	s.check(h.ensureCalls.length === 0, "nothing seeded while the editor is stale");

	h.state.editor = ""; // Obsidian finished loading the new, empty note
	const second = await h.manager["seedFromDisk"](h.view, "device-UniLaptop", "leaf-1", h.path, "test");
	s.check(second === "bound", "editor matches disk -> seeded and re-bound");
	s.check(
		h.ensureCalls.length === 1 && h.ensureCalls[0]!.content === "",
		"CRDT seeded from disk content",
	);
	s.check(h.rebinds.length === 1, "bind() re-run once the CRDT entry exists");
	h.manager.unbindAll();
}

s.section("Test 3: a seed is abandoned if the pane moved to another file");
{
	const h = makeHarness({ editor: OLD_NOTE, disk: "" });
	(h.view as { file: TFile }).file = partialOf<TFile>({ path: "elsewhere.md" });
	const result = await h.manager["seedFromDisk"](h.view, "d", "leaf-1", h.path, "test");
	s.check(result === "abandoned", "seed for test.md dropped after navigation");
	s.check(h.ensureCalls.length === 0, "no CRDT entry created for the abandoned path");
	h.manager.unbindAll();
}

s.section("Test 4: reconcile importing the file first wins over the editor seed");
{
	const h = makeHarness({ editor: OLD_NOTE, disk: "" });
	h.texts.set(h.path, new Y.Doc().getText("x"));
	const result = await h.manager["seedFromDisk"](h.view, "d", "leaf-1", h.path, "test");
	s.check(result === "bound", "existing CRDT entry is bound directly");
	s.check(h.ensureCalls.length === 0, "no second seed when the entry already exists");
	h.manager.unbindAll();
}

s.section("Test 5: genuine typing before the first save still binds after the settle budget");
{
	const h = makeHarness({ editor: "typed fast", disk: "" });
	h.manager["diskSeedAttempts"].set("leaf-1", 10_000);
	const result = await h.manager["seedFromDisk"](h.view, "d", "leaf-1", h.path, "test");
	s.check(result === "bound", "binding is not withheld forever");
	s.check(
		h.ensureCalls.length === 1 && h.ensureCalls[0]!.content === "typed fast",
		"after the budget the editor content is the local authority",
	);
	h.manager.unbindAll();
}

s.section("Test 6: end to end through the timers — stale switch converges to disk content");
{
	const h = makeHarness({ editor: OLD_NOTE, disk: "" });
	h.manager["resolveBindingTarget"](h.view, "d", "file-open");
	await new Promise((r) => setTimeout(r, 250)); // a couple of stale attempts
	s.check(h.ensureCalls.length === 0, "no seed while the editor is mid-switch");
	h.state.editor = ""; // Obsidian loads the new note
	const deadline = Date.now() + 3000;
	while (h.rebinds.length === 0 && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 25));
	}
	s.check(
		h.ensureCalls.length === 1 && h.ensureCalls[0]!.content === "",
		"new note's CRDT holds the disk content, not the previous note",
	);
	s.check(h.rebinds.length === 1, "editor is bound once seeded");
	s.check(h.manager["pendingDiskSeeds"].size === 0, "no seed timers left behind");
	h.manager.unbindAll();
}

await s.done();
