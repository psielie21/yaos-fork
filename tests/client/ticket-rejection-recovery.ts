import { readSource, suite } from "../harness.ts";
import { SocketTicketHttpError } from "../../src/sync/socketTicket";
import {
	MAX_TICKET_REJECTION_RECOVERIES,
	TicketRejectionRecovery,
	classifyTicketRefreshFailure,
} from "../../src/sync/ticketRejectionRecovery";
import { VaultSync } from "../../src/sync/vaultSync";

/**
 * Regression: "YAOS: Auth rejected" after the laptop slept, surviving every
 * "Reconnect to sync server" until the plugin was reloaded (BACKLOG ISSUE-68).
 *
 * The first reconnect after a sleep longer than the ticket TTL replays an
 * expired ticket (y-partyserver retries after 100 ms; the refresh is an HTTPS
 * round-trip and the proactive timer does not run during sleep). The server
 * answers "unauthorized", which the client latched permanently, and the
 * manual reconnect command was a no-op while latched.
 */
const s = suite("ticket-rejection-recovery");

s.section("Test 1: policy — only a ticket-authenticated 'unauthorized' is recoverable");
{
	const r = new TicketRejectionRecovery();
	s.check(r.onFatalFrame("unauthorized", false) === "latch", "rejected legacy ?token= still latches");
	s.check(r.onFatalFrame("update_required", true) === "latch", "schema mismatch still latches");
	s.check(r.onFatalFrame("unclaimed", true) === "latch", "unclaimed server still latches");
	s.check(r.onFatalFrame("server_misconfigured", true) === "latch", "misconfigured server still latches");
	s.check(r.onFatalFrame("unauthorized", true) === "recover", "stale-ticket candidate is recovered");
}

s.section("Test 2: policy — duplicate frames and a bounded budget");
{
	const r = new TicketRejectionRecovery();
	s.check(r.onFatalFrame("unauthorized", true) === "recover", "first rejection recovers");
	s.check(
		r.onFatalFrame("unauthorized", true) === "in-flight",
		"the server's duplicate fatal frame does not spend a second attempt",
	);
	r.settle();
	for (let i = 1; i < MAX_TICKET_REJECTION_RECOVERIES; i++) {
		s.check(r.onFatalFrame("unauthorized", true) === "recover", `attempt ${i + 1} recovers`);
		r.settle();
	}
	s.check(
		r.onFatalFrame("unauthorized", true) === "latch",
		"a server that rejects every fresh ticket ends latched, not in a loop",
	);
	r.onSynced();
	s.check(r.onFatalFrame("unauthorized", true) === "recover", "a real sync restores the budget");
	r.reset();
	s.check(!r.isInFlight && r.attemptCount === 0, "manual reset clears state");
}

s.section("Test 3: only 401/403 from the ticket endpoint proves the token is bad");
{
	s.check(classifyTicketRefreshFailure(new SocketTicketHttpError(401)) === "token-rejected", "401 rejects");
	s.check(classifyTicketRefreshFailure(new SocketTicketHttpError(403)) === "token-rejected", "403 rejects");
	s.check(classifyTicketRefreshFailure(new SocketTicketHttpError(500)) === "transient", "500 is transient");
	s.check(classifyTicketRefreshFailure(new SocketTicketHttpError(404)) === "transient", "404 is transient");
	s.check(classifyTicketRefreshFailure(new Error("net::ERR_INTERNET_DISCONNECTED")) === "transient", "network error is transient");
}

// ---------------------------------------------------------------------------
// Behaviour of the real VaultSync methods against a stubbed provider.
// ---------------------------------------------------------------------------

type TicketFn = (force?: boolean) => Promise<{ value: string; expiresAt: number; localExpiresAt: number; ttlMs: number } | null>;

function fakeVaultSync(getTicket: TicketFn) {
	const calls = { disconnect: 0, connect: 0, forced: 0 };
	const provider = {
		url: "wss://h/vault/sync/v?schemaVersion=3&ticket=STALE",
		disconnect: () => { calls.disconnect++; },
		connect: async () => { calls.connect++; },
	};
	const vs = Object.create(VaultSync.prototype) as Record<string, unknown>;
	Object.assign(vs, {
		provider,
		_destroyed: false,
		_fatalAuthError: false,
		_fatalAuthCode: null,
		_fatalAuthDetails: null,
		_ticketRejectionRecovery: new TicketRejectionRecovery(),
		_ticketRecoveryRetryTimer: null,
		_ticketRecoveryTransientFailures: 0,
		_socketTicketRefreshTimer: null,
		_providerSyncWaiters: new Set(),
		_eventRing: [],
		debug: false,
		_getSocketTicket: async (force?: boolean) => {
			if (force) calls.forced++;
			return getTicket(force);
		},
	});
	return { vs, provider, calls };
}

const freshTicket = async () => ({
	value: "FRESH", expiresAt: Date.now() + 300_000, localExpiresAt: Date.now() + 300_000, ttlMs: 300_000,
});

s.section("Test 4: stale ticket + valid token -> reconnect with a fresh ticket, no latch");
{
	const { vs, provider, calls } = fakeVaultSync(freshTicket);
	(vs._ticketRejectionRecovery as TicketRejectionRecovery).onFatalFrame("unauthorized", true);
	await (vs.recoverFromTicketRejection as () => Promise<void>).call(vs);
	s.check(vs._fatalAuthError === false, "client is NOT latched into 'Auth rejected'");
	s.check(calls.forced === 1, "token verified with a forced (uncached) ticket fetch");
	s.check(provider.url.includes("ticket=FRESH") && !provider.url.includes("STALE"), "provider URL carries the fresh ticket");
	s.check(calls.connect === 1, "provider reconnects");
	s.check(!(vs._ticketRejectionRecovery as TicketRejectionRecovery).isInFlight, "recovery settled");
	(vs.clearSocketTicketRefreshTimer as () => void).call(vs);
}

s.section("Test 5: token genuinely rejected -> latch exactly as before");
{
	const { vs, calls } = fakeVaultSync(async () => { throw new SocketTicketHttpError(401); });
	(vs._ticketRejectionRecovery as TicketRejectionRecovery).onFatalFrame("unauthorized", true);
	await (vs.recoverFromTicketRejection as () => Promise<void>).call(vs);
	s.check(vs._fatalAuthError === true && vs._fatalAuthCode === "unauthorized", "latched as unauthorized");
	s.check(calls.connect === 0, "no reconnect with a rejected token");
}

s.section("Test 6: offline during the check -> retry later, never latch");
{
	let online = false;
	const { vs, calls } = fakeVaultSync(async () => {
		if (!online) throw new Error("net::ERR_INTERNET_DISCONNECTED");
		return freshTicket();
	});
	(vs._ticketRejectionRecovery as TicketRejectionRecovery).onFatalFrame("unauthorized", true);
	await (vs.recoverFromTicketRejection as () => Promise<void>).call(vs);
	s.check(vs._fatalAuthError === false, "offline is not treated as an auth failure");
	s.check(vs._ticketRecoveryRetryTimer !== null, "a retry is scheduled");
	s.check(
		(vs._ticketRejectionRecovery as TicketRejectionRecovery).isInFlight,
		"stays in flight so stray frames cannot burn the budget",
	);
	online = true;
	(vs.clearTicketRecoveryRetryTimer as () => void).call(vs);
	await (vs.recoverFromTicketRejection as () => Promise<void>).call(vs);
	s.check(calls.connect === 1 && vs._fatalAuthError === false, "reconnects once the network is back");
	(vs.clearSocketTicketRefreshTimer as () => void).call(vs);
}

s.section("Test 7: 'Reconnect to sync server' clears a latch and uses a fresh ticket");
{
	const { vs, provider, calls } = fakeVaultSync(freshTicket);
	Object.assign(vs, { _fatalAuthError: true, _fatalAuthCode: "unauthorized" });
	const retried = (vs.retryAfterFatalAuth as (r: string) => boolean).call(vs, "manual-command");
	await new Promise((r) => setTimeout(r, 10));
	s.check(retried, "manual retry is attempted");
	s.check(vs._fatalAuthError === false, "latch cleared");
	s.check(calls.forced === 1 && provider.url.includes("ticket=FRESH"), "never reuses the rejected ticket");
	s.check(calls.connect === 1, "provider reconnects");
	(vs.clearSocketTicketRefreshTimer as () => void).call(vs);

	const upd = fakeVaultSync(freshTicket);
	Object.assign(upd.vs, { _fatalAuthError: true, _fatalAuthCode: "update_required" });
	s.check(
		!(upd.vs.retryAfterFatalAuth as (r: string) => boolean).call(upd.vs, "manual-command")
		&& upd.vs._fatalAuthError === true,
		"update_required stays latched (retrying cannot fix a schema mismatch)",
	);
}

s.section("Test 8: wiring contracts");
{
	const vaultSync = readSource("src/sync/vaultSync.ts");
	const handler = vaultSync.slice(
		vaultSync.indexOf("const handleFatalAuthPayload"),
		vaultSync.indexOf('this.provider.on("custom-message", handleFatalAuthPayload)'),
	);
	const decideAt = handler.indexOf("_ticketRejectionRecovery.onFatalFrame(");
	const latchAt = handler.indexOf("this.latchFatalAuth(msg)");
	s.check(decideAt >= 0 && latchAt > decideAt, "the fatal handler consults recovery before latching");
	s.check(handler.includes("this.providerUrlCarriesTicket()"), "recovery only applies to ticket-authenticated sockets");
	s.check(
		/provider\.on\("sync"[\s\S]{0,120}_ticketRejectionRecovery\.onSynced\(\)/.test(vaultSync),
		"budget resets on a real sync, not on socket open",
	);
	const controller = readSource("src/runtime/connectionController.ts");
	s.check(
		controller.includes("sync.retryAfterFatalAuth(reason)"),
		"manual reconnect retries instead of silently skipping",
	);
}

await s.done();
