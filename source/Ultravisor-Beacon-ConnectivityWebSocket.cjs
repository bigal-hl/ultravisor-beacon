/**
 * Ultravisor Beacon Connectivity — WebSocket Transport
 *
 * Provides a persistent WebSocket connection to the Ultravisor server.
 * Instead of polling for work, the server pushes work items directly
 * over the WebSocket.  Heartbeats are sent as WebSocket messages
 * instead of HTTP requests.
 *
 * The WebSocket client authenticates via HTTP first (to get a session
 * cookie), then upgrades to WebSocket with the cookie attached.
 *
 * Message protocol (JSON):
 *   Client -> Server:
 *     { Action: 'Register', Name, Capabilities, MaxConcurrent, Tags }
 *     { Action: 'Heartbeat', BeaconID }
 *     { Action: 'WorkComplete', WorkItemHash, Outputs, Log }
 *     { Action: 'WorkError', WorkItemHash, ErrorMessage, Log }
 *     { Action: 'WorkProgress', WorkItemHash, ... }
 *     { Action: 'Deregister', BeaconID }
 *
 *   Server -> Client:
 *     { EventType: 'Registered', BeaconID }
 *     { EventType: 'WorkItem', WorkItem: { ... } }
 *     { EventType: 'Deregistered' }
 */

class UltravisorBeaconConnectivityWebSocket
{
	constructor(pOptions)
	{
		this._Options = Object.assign({
			ServerURL: 'http://localhost:54321',
			// UserName — HTTP-auth identity for /1.0/Authenticate (used to
			// get the session cookie attached to the WS upgrade request).
			// Distinct from Name (the mesh handle UV uses for AffinityKey
			// routing). Must be forwarded through getTransportConfig so
			// the Service hands it to the BeaconClient, where _authenticate
			// uses it (falling back to Name when empty for backward compat
			// with promiscuous-UV / solo-beacon deployments).
			UserName: '',
			Password: '',
			PollIntervalMs: 5000,
			HeartbeatIntervalMs: 30000,
			ReconnectIntervalMs: 10000
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
			HeartbeatIntervalMs: this._Options.HeartbeatIntervalMs,
			ReconnectIntervalMs: this._Options.ReconnectIntervalMs,
			Transport: 'WebSocket'
		};
	}

	/**
	 * Get the transport type identifier.
	 *
	 * @returns {string}
	 */
	getTransportType()
	{
		return 'WebSocket';
	}
}

module.exports = UltravisorBeaconConnectivityWebSocket;
