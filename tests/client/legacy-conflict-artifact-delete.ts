import { readSource, suite } from "../harness.ts";
import { isMarkdownConflictArtifactPath } from "../../src/sync/markdownConflictArtifact";
import { isMarkdownSyncable } from "../../src/types";
import { DiskMirror } from "../../src/sync/diskMirror";

/**
 * Regression: deleted conflict notes come back on every restart.
 *
 * Older YAOS versions synced markdown conflict notes into the room. Since
 * they became local-only, their filename makes them non-syncable, so:
 *   - the vault delete handler ignored them (no tombstone ever written), and
 *   - startup reconcile skipped them in the disk scan, saw the legacy CRDT
 *     entry as "missing on disk", and wrote the file back.
 */
const s = suite("legacy-conflict-artifact-delete");

const reported =
	"PHD/Projects/AgenticAI/test (YAOS conflict - crdt from device-UniLaptop 2026-10-14T12-21-06Z).md";

s.section("Test 1: the reported filenames are conflict notes and non-syncable");
{
	s.check(isMarkdownConflictArtifactPath(reported), "reported conflict note matches the pattern");
	s.check(
		isMarkdownConflictArtifactPath(reported.replace(").md", ") 2.md")),
		"numbered duplicate matches the pattern",
	);
	s.check(!isMarkdownSyncable(reported, [], ".obsidian"), "conflict note is not markdown-syncable");
	s.check(!isMarkdownConflictArtifactPath("PHD/Projects/AgenticAI/test.md"), "the original note is unaffected");
}

s.section("Test 2: the disk mirror never materializes a legacy synced conflict note");
{
	const writes: string[] = [];
	const mirror = Object.create(DiskMirror.prototype) as Record<string, unknown>;
	Object.assign(mirror, {
		openPaths: new Set<string>(),
		log: () => {},
		scheduleOpenWrite: (p: string) => writes.push(`open:${p}`),
		scheduleClosedWrite: (p: string) => writes.push(`closed:${p}`),
	});
	const scheduleWrite = (mirror.scheduleWrite as (p: string) => void).bind(mirror);
	scheduleWrite(reported);
	s.check(writes.length === 0, "remote update for a conflict note is not written to disk");
	scheduleWrite("PHD/Projects/AgenticAI/test.md");
	s.check(writes.length === 1 && writes[0] === "closed:PHD/Projects/AgenticAI/test.md", "normal notes still write");
}

s.section("Test 3: startup reconcile does not recreate legacy conflict notes");
{
	const controller = readSource("src/runtime/reconciliationController.ts");
	const loopStart = controller.indexOf("for (const path of result.createdOnDisk) {");
	const guard = controller.indexOf("if (isMarkdownConflictArtifactPath(path)) {", loopStart);
	const flush = controller.indexOf("await diskMirror.flushWrite(path);", loopStart);
	s.check(loopStart >= 0 && guard > loopStart && guard < flush, "conflict notes are skipped before the CRDT-to-disk write");
}

s.section("Test 4: deleting a legacy synced conflict note tombstones it");
{
	const main = readSource("src/main.ts");
	const start = main.indexOf('this.app.vault.on("delete"');
	const end = main.indexOf('this.app.vault.on("create"', start);
	const handler = main.slice(start, end);
	const legacyBranch = handler.indexOf("isMarkdownConflictArtifactPath(file.path)");
	const blobBranch = handler.indexOf("const blobSync = this.getBlobSync();");
	s.check(legacyBranch >= 0 && legacyBranch < blobBranch, "delete handler has a legacy conflict-note branch");
	const branch = handler.slice(legacyBranch, blobBranch);
	s.check(branch.includes("this.vaultSync?.getTextForPath(file.path)"), "only acts when the note is actually in the CRDT");
	s.check(branch.includes("consumeDeleteSuppression(file.path)"), "deletes caused by a remote tombstone are not echoed back");
	s.check(branch.includes("this.vaultSync.handleDelete(file.path"), "the legacy entry is tombstoned");

	const vaultSync = readSource("src/sync/vaultSync.ts");
	const hd = vaultSync.slice(
		vaultSync.indexOf("handleDelete(path: string, device?: string, opId?: string): void {"),
		vaultSync.indexOf("handleDelete(path: string, device?: string, opId?: string): void {") + 4000,
	);
	s.check(!hd.includes("isMarkdownSyncable") && !hd.includes("isMarkdownConflictArtifactPath"), "handleDelete itself does not filter the path out");
}

await s.done();
