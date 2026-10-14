/**
 * Recovery policy for a WebSocket "unauthorized" rejection.
 *
 * # Why this exists
 * The server answers an expired ticket and a wrong token identically
 * ("unauthorized"). The client used to treat both as fatal and latch: every
 * later reconnect, including the manual "Reconnect to sync server" command,
 * was skipped until the plugin was reloaded.
 *
 * Expired tickets are routine. When a connected socket closes, y-partyserver
 * retries after 100 ms using the ticket already in provider.url. The refresh
 * VaultSync starts on "disconnected" is an HTTPS round-trip that usually loses
 * that race, and the proactive refresh timer does not run while the machine
 * sleeps. So after any sleep or idle longer than the ticket TTL, the first
 * reconnect presents an expired ticket, and the rejection used to strand the
 * client permanently (BACKLOG ISSUE-68: "Auth rejected after idle time and
 * must reload the plugin").
 *
 * # Policy
 * A ticket rejection is only a hint. The authoritative check is the HTTP
 * ticket endpoint, which validates the long-lived token itself:
 *   - fetch succeeds   → token is valid, the ticket was stale: reconnect.
 *   - 401 / 403        → token is genuinely rejected: latch as before.
 *   - anything else    → transient (offline, 5xx): retry later, do not latch.
 * Recoveries are bounded so a server that rejects every fresh ticket still
 * ends in the latched state instead of a reconnect loop. The budget resets
 * only when the provider actually syncs with the server.
 */

import { SocketTicketHttpError } from "./socketTicket";

export const MAX_TICKET_REJECTION_RECOVERIES = 3;

export type TicketRejectionDecision =
	/** Treat as fatal (the pre-existing behaviour). */
	| "latch"
	/** Verify the token over HTTP and reconnect with a fresh ticket. */
	| "recover"
	/** A recovery is already running (the server sends each fatal frame twice). */
	| "in-flight";

export type TicketRefreshFailure = "token-rejected" | "transient";

export function classifyTicketRefreshFailure(err: unknown): TicketRefreshFailure {
	if (err instanceof SocketTicketHttpError && (err.status === 401 || err.status === 403)) {
		return "token-rejected";
	}
	return "transient";
}

export class TicketRejectionRecovery {
	private attempts = 0;
	private inFlight = false;

	constructor(private readonly maxAttempts = MAX_TICKET_REJECTION_RECOVERIES) {}

	/**
	 * Decide what to do with a fatal auth frame.
	 *
	 * @param code        fatal code sent by the server
	 * @param usedTicket  the rejected connection authenticated with ?ticket=
	 *                    (a rejected legacy ?token= is a real token failure)
	 */
	onFatalFrame(code: string, usedTicket: boolean): TicketRejectionDecision {
		if (code !== "unauthorized" || !usedTicket) return "latch";
		if (this.inFlight) return "in-flight";
		if (this.attempts >= this.maxAttempts) return "latch";
		this.attempts += 1;
		this.inFlight = true;
		return "recover";
	}

	/** The recovery attempt finished (reconnected, latched, or will retry). */
	settle(): void {
		this.inFlight = false;
	}

	/** The provider synced with the server: the connection is genuinely healthy. */
	onSynced(): void {
		this.attempts = 0;
	}

	/** Explicit user retry: start over with a full budget. */
	reset(): void {
		this.attempts = 0;
		this.inFlight = false;
	}

	get attemptCount(): number {
		return this.attempts;
	}

	get isInFlight(): boolean {
		return this.inFlight;
	}
}
