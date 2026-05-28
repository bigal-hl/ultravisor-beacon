/**
 * Ultravisor Beacon Connectivity — HTTP Transport
 *
 * Thin configuration layer for HTTP-based beacon connectivity.
 * The actual HTTP transport is handled by the thin client
 * (Ultravisor-Beacon-Client.cjs).  This class exists as the
 * abstraction point for swapping in alternative transports
 * (e.g. WebSocket) in the future.
 *
 * For the HTTP transport, the thin client's polling, heartbeat,
 * authentication, and reconnection logic are used as-is.
 */

class UltravisorBeaconConnectivityHTTP
{
	constructor(pOptions)
	{
		this._Options = Object.assign({
			ServerURL: 'http://localhost:54321',
			// UserName — HTTP-auth identity for /1.0/Authenticate. Distinct
			// from Name (the mesh handle UV uses for AffinityKey routing).
			// Must be forwarded through getTransportConfig so the Service
			// hands it to the BeaconClient, where _authenticate uses it
			// (falling back to Name when empty for backward compat with
			// promiscuous-UV / solo-beacon deployments).
			UserName: '',
			Password: '',
			PollIntervalMs: 5000,
			HeartbeatIntervalMs: 30000
		}, pOptions || {});
	}

	/**
	 * Get the transport configuration subset needed by the thin client.
	 *
	 * @returns {object} Config suitable for BeaconClient constructor
	 */
	getTransportConfig()
	{
		return {
			ServerURL: this._Options.ServerURL,
			UserName: this._Options.UserName,
			Password: this._Options.Password,
			PollIntervalMs: this._Options.PollIntervalMs,
			HeartbeatIntervalMs: this._Options.HeartbeatIntervalMs
		};
	}

	/**
	 * Get the transport type identifier.
	 *
	 * @returns {string}
	 */
	getTransportType()
	{
		return 'HTTP';
	}
}

module.exports = UltravisorBeaconConnectivityHTTP;
