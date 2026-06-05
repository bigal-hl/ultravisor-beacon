/**
 * Ultravisor Beacon Client
 *
 * A lightweight worker node that connects to an Ultravisor server,
 * registers its capabilities, polls for work, executes tasks locally,
 * and reports results back to the orchestrator.
 *
 * Capabilities are provided by pluggable CapabilityProviders loaded
 * via the ProviderRegistry. The beacon advertises the aggregate set
 * of capabilities from all loaded providers.
 *
 * Communication is HTTP-based (transport-agnostic design means this
 * can be swapped for WebSocket, MQTT, etc. in the future).
 */

const libHTTP = require('http');
const libHTTPS = require('https');
const libOS = require('os');
const libFS = require('fs');
const libPath = require('path');
const libCrypto = require('crypto');

let libWebSocket;
try
{
	libWebSocket = require('ws');
}
catch (pError)
{
	// ws is optional — only required for WebSocket transport
	libWebSocket = null;
}

const libBeaconExecutor = require('./Ultravisor-Beacon-Executor.cjs');

class UltravisorBeaconClient
{
	constructor(pConfig)
	{
		this._Config = Object.assign({
			ServerURL: 'http://localhost:54321',
			Name: 'beacon-worker',
			// UserName — HTTP-auth identity for /1.0/Authenticate (gets
			// the session cookie used by HTTP polling + any session-gated
			// REST). Distinct from Name (the mesh handle UV uses for
			// AffinityKey routing) because shared UVs (e.g. QA) require
			// the auth-beacon to validate a REAL user account, and
			// "beacon-worker" or "data-mapper" usually aren't. When
			// unset (or empty), falls back to Name for backward compat
			// with promiscuous-UV / solo-beacon deployments.
			UserName: '',
			Password: '',
			// JoinSecret — opaque token presented on BeaconRegister so
			// ultravisor's optional non-promiscuous mode can validate
			// the beacon's right to join the mesh. Empty string ('') is
			// fine when ultravisor runs in default (promiscuous) mode.
			// In non-promiscuous mode an empty/wrong secret is rejected
			// at registration time.
			JoinSecret: '',
			Capabilities: ['Shell'],
			MaxConcurrent: 1,
			PollIntervalMs: 5000,
			HeartbeatIntervalMs: 30000,
			ReconnectIntervalMs: 10000,
			StagingPath: process.cwd(),
			Tags: {},
			// Phase 4 — Pillar 3: when true, skip the WS attempt and
			// connect via HTTP-poll only. Lets a synthetic-beacon-runner
			// emulate firewall-restricted / IoT-style consumers that
			// can't hold a WebSocket open. The fallback path the client
			// already takes when libWebSocket is missing exercises this
			// same code; ForceHTTPTransport just makes it deterministic.
			ForceHTTPTransport: false
		}, pConfig || {});

		// Logger: use provided Fable log or fall back to console
		this.log = this._Config.Log || {
			trace: (...pArgs) => { console.log(...pArgs); },
			debug: (...pArgs) => { console.log(...pArgs); },
			info: (...pArgs) => { console.log(...pArgs); },
			warn: (...pArgs) => { console.warn(...pArgs); },
			error: (...pArgs) => { console.error(...pArgs); }
		};

		this._BeaconID = null;
		this._PollInterval = null;
		this._HeartbeatInterval = null;
		this._Running = false;
		this._ActiveWorkItems = 0;
		this._SessionCookie = null;
		this._Authenticating = false;
		this._ReconnectPending = false;
		this._ReconnectAttempts = 0;
		this._MaxReconnectDelayMs = 300000;

		// WebSocket transport state — determined at runtime, not config
		this._WebSocket = null;
		this._UseWebSocket = false;

		this._Executor = new libBeaconExecutor({
			StagingPath: this._Config.StagingPath,
			Log: this.log
		});

		// Load capability providers
		this._loadProviders();
	}

	// ================================================================
	// Provider Loading
	// ================================================================

	_loadProviders()
	{
		let tmpProviders = this._Config.Providers;

		if (!tmpProviders)
		{
			// Backward compatibility: convert Capabilities array to Provider descriptors
			let tmpCapabilities = this._Config.Capabilities || ['Shell'];
			tmpProviders = tmpCapabilities.map(function (pCap)
			{
				return { Source: pCap, Config: {} };
			});
		}

		// Two shapes are accepted in `Providers`:
		//
		//   1. Descriptor:  { Source: '<built-in name | path | npm pkg>', Config: {...} }
		//      The registry resolves Source to a class and instantiates it. This is
		//      what the existing config-file driven flow uses.
		//
		//   2. Pre-instantiated provider:  any object that already has .Capability +
		//      .execute (i.e. extends UltravisorBeaconCapabilityProvider). Useful when
		//      a wrapper module — like ultravisor-auth-beacon — needs to inject runtime
		//      state into the provider before the beacon connects.
		//
		// We split the array, route descriptors through loadProviders (Source-based)
		// and instances through registerProvider (instance-based). The combined count
		// becomes the log line so the operator sees the same total either way.
		let tmpDescriptors = [];
		let tmpInstances = [];
		for (let i = 0; i < tmpProviders.length; i++)
		{
			let tmpP = tmpProviders[i];
			if (tmpP && typeof tmpP.Capability === 'string' && typeof tmpP.execute === 'function')
			{
				tmpInstances.push(tmpP);
			}
			else
			{
				tmpDescriptors.push(tmpP);
			}
		}
		let tmpCount = this._Executor.providerRegistry.loadProviders(tmpDescriptors);
		for (let i = 0; i < tmpInstances.length; i++)
		{
			if (this._Executor.providerRegistry.registerProvider(tmpInstances[i]))
			{
				tmpCount++;
			}
		}
		this.log.info(`[Beacon] Loaded ${tmpCount} capability provider(s).`);
	}

	// ================================================================
	// Lifecycle
	// ================================================================

	/**
	 * Start the Beacon client: initialize providers, register, then begin polling.
	 */
	start(fCallback)
	{
		this.log.info(`[Beacon] Starting "${this._Config.Name}"...`);
		this.log.info(`[Beacon] Server: ${this._Config.ServerURL}`);

		// Initialize all providers before registering
		this._Executor.providerRegistry.initializeAll((pInitError) =>
		{
			if (pInitError)
			{
				this.log.error(`[Beacon] Provider initialization failed: ${pInitError.message}`);
				return fCallback(pInitError);
			}

			let tmpCapabilities = this._Executor.providerRegistry.getCapabilities();
			this.log.info(`[Beacon] Capabilities: ${tmpCapabilities.join(', ')}`);

			// Authenticate before registering (both transports need a session)
			this._authenticate((pAuthError) =>
			{
				if (pAuthError)
				{
					this.log.error(`[Beacon] Authentication failed: ${pAuthError.message}`);
					return fCallback(pAuthError);
				}

				this.log.info(`[Beacon] Authenticated successfully.`);

				// Phase 4 — Pillar 3: ForceHTTPTransport skips the WS
				// attempt entirely. Used by polling-mode beacons that
				// must run without holding a socket open.
				if (this._Config.ForceHTTPTransport)
				{
					this.log.info(`[Beacon] ForceHTTPTransport=true; using HTTP polling.`);
					this._UseWebSocket = false;
					return this._startHTTP(fCallback);
				}

				// Try WebSocket first — if ws library is available and the
				// server supports it, we get push-based work dispatch.
				// Falls back to HTTP polling automatically.
				if (libWebSocket)
				{
					this._startWebSocket((pWSError, pBeacon) =>
					{
						if (pWSError)
						{
							this.log.info(`[Beacon] WebSocket unavailable (${pWSError.message}), using HTTP polling.`);
							this._UseWebSocket = false;
							this._startHTTP(fCallback);
							return;
						}
						this._UseWebSocket = true;
						return fCallback(null, pBeacon);
					});
				}
				else
				{
					this._startHTTP(fCallback);
				}
			});
		});
	}

	/**
	 * Start with HTTP transport: register via REST, then poll for work.
	 */
	_startHTTP(fCallback)
	{
		this._register((pError, pBeacon) =>
		{
			if (pError)
			{
				this.log.error(`[Beacon] Registration failed: ${pError.message}`);
				return fCallback(pError);
			}

			this._BeaconID = pBeacon.BeaconID;
			this._Running = true;

			this.log.info(`[Beacon] Registered as ${this._BeaconID}`);

			// Start polling for work
			this._PollInterval = setInterval(() =>
			{
				this._poll();
			}, this._Config.PollIntervalMs);

			// Start heartbeat
			this._HeartbeatInterval = setInterval(() =>
			{
				this._heartbeat();
			}, this._Config.HeartbeatIntervalMs);

			// Do an immediate poll
			this._poll();

			return fCallback(null, pBeacon);
		});
	}

	/**
	 * Stop the Beacon client: stop polling/WebSocket, shutdown providers, deregister.
	 */
	stop(fCallback)
	{
		this.log.info(`[Beacon] Stopping...`);
		this._Running = false;

		if (this._PollInterval)
		{
			clearInterval(this._PollInterval);
			this._PollInterval = null;
		}

		if (this._HeartbeatInterval)
		{
			clearInterval(this._HeartbeatInterval);
			this._HeartbeatInterval = null;
		}

		// Close WebSocket if open
		if (this._WebSocket)
		{
			if (this._BeaconID)
			{
				// Send deregister message before closing
				this._wsSend({ Action: 'Deregister', BeaconID: this._BeaconID });
			}
			this._WebSocket.onclose = null;
			this._WebSocket.close();
			this._WebSocket = null;
		}

		// Clean up affinity staging directories
		this._Executor.cleanupAffinityDirs();

		// Shutdown providers
		this._Executor.providerRegistry.shutdownAll((pShutdownError) =>
		{
			if (pShutdownError)
			{
				this.log.warn(`[Beacon] Provider shutdown warning: ${pShutdownError.message}`);
			}

			if (this._BeaconID)
			{
				this._deregister((pError) =>
				{
					if (pError)
					{
						this.log.warn(`[Beacon] Deregistration warning: ${pError.message}`);
					}
					this.log.info(`[Beacon] Stopped.`);
					if (fCallback) return fCallback(null);
				});
			}
			else
			{
				this.log.info(`[Beacon] Stopped.`);
				if (fCallback) return fCallback(null);
			}
		});
	}

	// ================================================================
	// Authentication
	// ================================================================

	_authenticate(fCallback)
	{
		// Use the dedicated UserName when set; fall back to Name otherwise.
		// Name is the mesh handle UV uses for AffinityKey routing, while
		// UserName must match a registered account on the auth-beacon for
		// /1.0/Authenticate to return a real session cookie. Most deploys
		// use the same value for both; the split matters on shared UVs
		// where beacon names are arbitrary handles like "data-mapper" and
		// the auth-beacon's user accounts are operator emails / service-
		// account IDs.
		let tmpUserName = (typeof this._Config.UserName === 'string' && this._Config.UserName.length > 0)
			? this._Config.UserName
			: this._Config.Name;
		let tmpBody = {
			UserName: tmpUserName,
			Password: this._Config.Password || ''
		};

		let tmpBodyString = JSON.stringify(tmpBody);
		let tmpParsedURL = new URL(this._Config.ServerURL);
		let tmpOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || (tmpParsedURL.protocol === 'https:' ? 443 : 80),
			path: '/1.0/Authenticate',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(tmpBodyString)
			}
		};

		let tmpReq = (tmpParsedURL.protocol === 'https:' ? libHTTPS : libHTTP).request(tmpOptions, (pResponse) =>
		{
			let tmpData = '';
			pResponse.on('data', (pChunk) => { tmpData += pChunk; });
			pResponse.on('end', () =>
			{
				if (pResponse.statusCode >= 400)
				{
					return fCallback(new Error(`Authentication failed with HTTP ${pResponse.statusCode}`));
				}

				// Parse the body up front. UV's orator-authentication
				// returns HTTP 200 with `{ LoggedIn: false, Error: '...' }`
				// when the credentials don't validate against the auth-
				// beacon AND crucially does NOT send a Set-Cookie header
				// in that case. Without an explicit check we used to log
				// "Authenticated successfully" and proceed with _Session-
				// Cookie still null — every HTTP-polling work fetch + any
				// session-gated REST call would then 401. We don't abort
				// the beacon because the WS transport path authenticates
				// via JoinSecret on BeaconRegister and works without a
				// session cookie; only HTTP polling + REST need it.
				let tmpParsed = null;
				if (tmpData && tmpData.length > 0)
				{
					try { tmpParsed = JSON.parse(tmpData); }
					catch (pParseError)
					{
						return fCallback(new Error(`Invalid JSON in auth response: ${tmpData.substring(0, 200)}`));
					}
				}

				if (tmpParsed && tmpParsed.LoggedIn === false)
				{
					let tmpReason = tmpParsed.Error || 'auth-beacon rejected credentials';
					let tmpHint = (this._Config.UserName && this._Config.UserName !== this._Config.Name)
						? `Tried UserName="${tmpUserName}" (Beacon Name="${this._Config.Name}"). Verify the user account exists on the auth-beacon.`
						: `Tried UserName="${tmpUserName}". Either register a user account with that name on the auth-beacon, OR set a separate UserName (--user / DATABEACON_BEACON_USER) pointing at an existing account — Name stays the mesh handle.`;
					this.log.warn(`[Beacon] HTTP auth rejected — ${tmpReason} ${tmpHint} WS transport will still register via JoinSecret, but HTTP polling + any session-gated REST will 401.`);
					// Still return success so the caller (which proceeds
					// to _startWebSocket) keeps going. Empirically the
					// WS path's JoinSecret auth is independent of the
					// HTTP session.
					return fCallback(null, tmpParsed);
				}

				// Extract session cookie from Set-Cookie headers
				let tmpSetCookieHeaders = pResponse.headers['set-cookie'];
				if (tmpSetCookieHeaders && tmpSetCookieHeaders.length > 0)
				{
					// Take the name=value portion (before the first semicolon)
					let tmpCookieParts = tmpSetCookieHeaders[0].split(';');
					this._SessionCookie = tmpCookieParts[0].trim();
					this.log.info(`[Beacon] Session cookie acquired.`);
				}
				else if (tmpParsed && tmpParsed.LoggedIn === true)
				{
					// LoggedIn:true should always come with Set-Cookie —
					// surface the protocol-level oddity so an operator
					// can investigate (e.g. a proxy stripping cookies).
					this.log.warn(`[Beacon] Auth reports LoggedIn:true but no Set-Cookie header — session-gated REST will 401. Check for an HTTP proxy stripping cookies.`);
				}

				return fCallback(null, tmpParsed || {});
			});
		});

		tmpReq.on('error', (pError) =>
		{
			return fCallback(pError);
		});

		tmpReq.write(tmpBodyString);
		tmpReq.end();
	}

	// ================================================================
	// Reconnection
	// ================================================================

	_reconnect()
	{
		if (this._Authenticating)
		{
			return;
		}
		this._Authenticating = true;

		// Clear existing intervals
		if (this._PollInterval)
		{
			clearInterval(this._PollInterval);
			this._PollInterval = null;
		}
		if (this._HeartbeatInterval)
		{
			clearInterval(this._HeartbeatInterval);
			this._HeartbeatInterval = null;
		}

		this._SessionCookie = null;

		this.log.info(`[Beacon] Reconnecting — re-authenticating...`);

		this._authenticate((pAuthError) =>
		{
			if (pAuthError)
			{
				this.log.error(`[Beacon] Re-authentication failed: ${pAuthError.message}`);
				this._Authenticating = false;
				setTimeout(() => { this._reconnect(); }, 10000);
				return;
			}

			this.log.info(`[Beacon] Re-authenticated, re-registering...`);

			this._register((pRegError, pBeacon) =>
			{
				if (pRegError)
				{
					this.log.error(`[Beacon] Re-registration failed: ${pRegError.message}`);
					this._Authenticating = false;
					setTimeout(() => { this._reconnect(); }, 10000);
					return;
				}

				this._BeaconID = pBeacon.BeaconID;
				this._Authenticating = false;

				this.log.info(`[Beacon] Reconnected as ${this._BeaconID}`);

				// Restart polling
				this._PollInterval = setInterval(() =>
				{
					this._poll();
				}, this._Config.PollIntervalMs);

				// Restart heartbeat
				this._HeartbeatInterval = setInterval(() =>
				{
					this._heartbeat();
				}, this._Config.HeartbeatIntervalMs);

				// Immediate poll
				this._poll();
			});
		});
	}

	// ================================================================
	// Registration
	// ================================================================

	/**
	 * Public re-registration entrypoint. Called by the parent service
	 * after capabilities are added/removed post-enable() so the hub's
	 * beacon record reflects the new capability list. Same payload as
	 * the initial /Beacon/Register; the coordinator's registerBeacon
	 * path is idempotent on (Name, BeaconID) and updates the existing
	 * beacon's Capabilities + ActionSchemas in place.
	 */
	refreshRegistration(fCallback)
	{
		return this._register(fCallback || (() => {}));
	}

	_register(fCallback)
	{
		let tmpBody = {
			Name: this._Config.Name,
			Capabilities: this._Executor.providerRegistry.getCapabilities(),
			ActionSchemas: this._Executor.providerRegistry.getActionSchemas(),
			MaxConcurrent: this._Config.MaxConcurrent,
			Tags: this._Config.Tags
		};

		// Include contexts if any are defined
		if (this._Config.Contexts && Object.keys(this._Config.Contexts).length > 0)
		{
			tmpBody.Contexts = this._Config.Contexts;
		}

		// Include operations if any are defined
		if (Array.isArray(this._Config.Operations) && this._Config.Operations.length > 0)
		{
			tmpBody.Operations = this._Config.Operations;
		}

		// Include bind addresses so the coordinator knows how to reach us
		if (Array.isArray(this._Config.BindAddresses) && this._Config.BindAddresses.length > 0)
		{
			tmpBody.BindAddresses = this._Config.BindAddresses;
		}

		// Host identity — used by the reachability matrix to detect beacons that
		// live on the same physical machine. Caller can override; default is the
		// node hostname (which inside a container is the container ID).
		tmpBody.HostID = this._Config.HostID || libOS.hostname();

		// Shared filesystem mounts — each entry tells the coordinator about a
		// local filesystem tree this beacon advertises as accessible. When two
		// beacons report the same MountID, the reachability matrix can pick the
		// "shared-fs" strategy to skip an HTTP file transfer entirely.
		//
		// The MountID derivation includes stat.dev so two beacons that bind-mount
		// the same host directory get the same ID, while two unrelated /media
		// directories on different machines get different IDs.
		tmpBody.SharedMounts = this._normalizeSharedMounts(this._Config.SharedMounts);

		// Optional join secret for ultravisor's non-promiscuous mode.
		// Mirrors the WS register payload — only sent when configured so
		// promiscuous-mode HTTP traffic is byte-identical to before.
		if (this._Config.JoinSecret)
		{
			tmpBody.JoinSecret = this._Config.JoinSecret;
		}

		this._httpRequest('POST', '/Beacon/Register', tmpBody, fCallback);
	}

	_normalizeSharedMounts(pMounts)
	{
		if (!Array.isArray(pMounts) || pMounts.length === 0)
		{
			return [];
		}
		let tmpResult = [];
		for (let i = 0; i < pMounts.length; i++)
		{
			let tmpEntry = pMounts[i];
			if (!tmpEntry || !tmpEntry.Root)
			{
				continue;
			}
			let tmpRoot;
			try
			{
				tmpRoot = libPath.resolve(tmpEntry.Root);
			}
			catch (pError)
			{
				continue;
			}
			let tmpMountID = tmpEntry.MountID;
			if (!tmpMountID)
			{
				try
				{
					let tmpStat = libFS.statSync(tmpRoot);
					tmpMountID = libCrypto.createHash('sha256')
						.update(tmpStat.dev + ':' + tmpRoot)
						.digest('hex').substring(0, 16);
				}
				catch (pError)
				{
					// Mount root does not exist on this beacon — skip it.
					continue;
				}
			}
			tmpResult.push({
				MountID: tmpMountID,
				Root: tmpRoot
			});
		}
		return tmpResult;
	}

	_deregister(fCallback)
	{
		this._httpRequest('DELETE', `/Beacon/${this._BeaconID}`, null, fCallback);
	}

	// ================================================================
	// Polling
	// ================================================================

	_poll()
	{
		if (!this._Running || !this._BeaconID)
		{
			return;
		}

		if (this._ActiveWorkItems >= this._Config.MaxConcurrent)
		{
			return;
		}

		this._httpRequest('POST', '/Beacon/Work/Poll', { BeaconID: this._BeaconID },
			(pError, pResponse) =>
			{
				if (pError)
				{
					// Silent on poll errors — just retry next interval
					return;
				}

				if (!pResponse || !pResponse.WorkItem)
				{
					// No work available
					return;
				}

				// Execute the work item
				this._executeWorkItem(pResponse.WorkItem);
			});
	}

	// ================================================================
	// Work Execution
	// ================================================================

	_executeWorkItem(pWorkItem)
	{
		this._ActiveWorkItems++;
		this.log.info(`[Beacon] Executing work item [${pWorkItem.WorkItemHash}] (${pWorkItem.Capability}/${pWorkItem.Action})`);

		// Create a progress callback that sends updates to the server
		let tmpWorkItemHash = pWorkItem.WorkItemHash;
		let fReportProgress = (pProgressData) =>
		{
			if (this._UseWebSocket)
			{
				this._wsReportProgress(tmpWorkItemHash, pProgressData);
			}
			else
			{
				this._reportProgress(tmpWorkItemHash, pProgressData);
			}
		};

		this._Executor.execute(pWorkItem, (pError, pResult) =>
		{
			this._ActiveWorkItems--;

			if (pError)
			{
				this.log.error(`[Beacon] Execution error for [${pWorkItem.WorkItemHash}]: ${pError.message}`);
				if (this._UseWebSocket)
				{
					this._wsReportError(pWorkItem.WorkItemHash, pError.message, []);
				}
				else
				{
					this._reportError(pWorkItem.WorkItemHash, pError.message, []);
				}
				return;
			}

			// Check if the result indicates an error (non-zero exit code)
			let tmpOutputs = pResult.Outputs || {};
			if (tmpOutputs.ExitCode && tmpOutputs.ExitCode !== 0)
			{
				this.log.warn(`[Beacon] Work item [${pWorkItem.WorkItemHash}] completed with exit code ${tmpOutputs.ExitCode}`);
			}
			else
			{
				this.log.info(`[Beacon] Work item [${pWorkItem.WorkItemHash}] completed successfully.`);
			}

			// Upload output file if one was produced (Result is a local path)
			let tmpResultPath = tmpOutputs.Result;
			let tmpSettings = pWorkItem.Settings || {};
			let tmpOutputFilename = tmpSettings.OutputFile || tmpSettings.OutputFilename || '';
			if (tmpResultPath && tmpOutputFilename && this._UseWebSocket
				&& this._WebSocket && this._WebSocket.readyState === libWebSocket.OPEN)
			{
				let tmpFS = require('fs');
				if (tmpFS.existsSync(tmpResultPath))
				{
					try
					{
						let tmpBuffer = tmpFS.readFileSync(tmpResultPath);
						this.log.info(`[Beacon] Uploading result file ${tmpOutputFilename} (${tmpBuffer.length} bytes) for [${pWorkItem.WorkItemHash}]`);
						this._wsSend({
							Action: 'WorkResultUpload',
							WorkItemHash: pWorkItem.WorkItemHash,
							OutputFilename: tmpOutputFilename,
							OutputSize: tmpBuffer.length
						});
						this._WebSocket.send(tmpBuffer);
					}
					catch (pUploadError)
					{
						this.log.error(`[Beacon] Failed to upload result file: ${pUploadError.message}`);
					}
				}
			}

			if (this._UseWebSocket)
			{
				this._wsReportComplete(pWorkItem.WorkItemHash, tmpOutputs, pResult.Log || []);
			}
			else
			{
				this._reportComplete(pWorkItem.WorkItemHash, tmpOutputs, pResult.Log || []);
			}
		}, fReportProgress);
	}

	// ================================================================
	// Reporting
	// ================================================================

	_reportComplete(pWorkItemHash, pOutputs, pLog)
	{
		this._httpRequest('POST', `/Beacon/Work/${pWorkItemHash}/Complete`,
			{ Outputs: pOutputs, Log: pLog },
			(pError) =>
			{
				if (pError)
				{
					this.log.error(`[Beacon] Failed to report completion for [${pWorkItemHash}]: ${pError.message}`);
				}
			});
	}

	_reportError(pWorkItemHash, pErrorMessage, pLog)
	{
		this._httpRequest('POST', `/Beacon/Work/${pWorkItemHash}/Error`,
			{ ErrorMessage: pErrorMessage, Log: pLog },
			(pError) =>
			{
				if (pError)
				{
					this.log.error(`[Beacon] Failed to report error for [${pWorkItemHash}]: ${pError.message}`);
				}
			});
	}

	_reportProgress(pWorkItemHash, pProgressData)
	{
		if (!pProgressData || !this._Running)
		{
			return;
		}

		this._httpRequest('POST', `/Beacon/Work/${pWorkItemHash}/Progress`,
			pProgressData,
			(pError) =>
			{
				if (pError)
				{
					// Fire-and-forget — log but don't affect execution
					this.log.warn(`[Beacon] Failed to report progress for [${pWorkItemHash}]: ${pError.message}`);
				}
			});
	}

	// ================================================================
	// Heartbeat
	// ================================================================

	_heartbeat()
	{
		if (!this._Running || !this._BeaconID)
		{
			return;
		}

		this._httpRequest('POST', `/Beacon/${this._BeaconID}/Heartbeat`, {},
			(pError) =>
			{
				if (pError)
				{
					this.log.warn(`[Beacon] Heartbeat failed: ${pError.message}`);
				}
			});
	}

	// ================================================================
	// HTTP Transport
	// ================================================================

	_httpRequest(pMethod, pPath, pBody, fCallback)
	{
		let tmpParsedURL = new URL(this._Config.ServerURL);
		let tmpOptions = {
			hostname: tmpParsedURL.hostname,
			port: tmpParsedURL.port || (tmpParsedURL.protocol === 'https:' ? 443 : 80),
			path: pPath,
			method: pMethod,
			headers: {
				'Content-Type': 'application/json'
			}
		};

		// Attach session cookie if available
		if (this._SessionCookie)
		{
			tmpOptions.headers['Cookie'] = this._SessionCookie;
		}

		let tmpReq = (tmpParsedURL.protocol === 'https:' ? libHTTPS : libHTTP).request(tmpOptions, (pResponse) =>
		{
			let tmpData = '';
			pResponse.on('data', (pChunk) => { tmpData += pChunk; });
			pResponse.on('end', () =>
			{
				// Detect 401 and trigger reconnection
				if (pResponse.statusCode === 401)
				{
					this._reconnect();
					return fCallback(new Error('Unauthorized — reconnecting'));
				}

				try
				{
					let tmpParsed = JSON.parse(tmpData);
					if (pResponse.statusCode >= 400)
					{
						return fCallback(new Error(tmpParsed.Error || `HTTP ${pResponse.statusCode}`));
					}
					return fCallback(null, tmpParsed);
				}
				catch (pParseError)
				{
					return fCallback(new Error(`Invalid JSON response: ${tmpData.substring(0, 200)}`));
				}
			});
		});

		tmpReq.on('error', (pError) =>
		{
			return fCallback(pError);
		});

		if (pBody && (pMethod === 'POST' || pMethod === 'PUT'))
		{
			tmpReq.write(JSON.stringify(pBody));
		}

		tmpReq.end();
	}

	// ================================================================
	// WebSocket Transport
	// ================================================================

	/**
	 * Start with WebSocket transport: open a persistent connection,
	 * register over the socket, and receive work items via push.
	 */
	_startWebSocket(fCallback)
	{
		if (!libWebSocket)
		{
			return fCallback(new Error('WebSocket transport requires the "ws" package. Install it with: npm install ws'));
		}

		// Build WebSocket URL from the server URL
		let tmpParsedURL = new URL(this._Config.ServerURL);
		let tmpWSProtocol = (tmpParsedURL.protocol === 'https:') ? 'wss:' : 'ws:';
		let tmpWSURL = tmpWSProtocol + '//' + tmpParsedURL.host;

		let tmpHeaders = {};
		if (this._SessionCookie)
		{
			tmpHeaders['Cookie'] = this._SessionCookie;
		}

		try
		{
			// maxPayload: a beacon's outbound work-item completion can include
			// a large Result string (a typed-op State edge ships the records
			// from one node to the next). At 250K rows that's 40-60 MB.
			// `ws`'s default 100 MB inbound limit applies to the SERVER side
			// (UV) — but the client also tracks payload size and aborts
			// frame buffering when it sees a frame above that limit. Match
			// UV's bumped limit so the client doesn't silently drop frames.
			let tmpMaxPayloadMB = parseInt(process.env.UltravisorBeaconWebSocketMaxPayloadMB, 10);
			if (!Number.isFinite(tmpMaxPayloadMB) || tmpMaxPayloadMB <= 0) tmpMaxPayloadMB = 256;
			this._WebSocket = new libWebSocket(tmpWSURL, { headers: tmpHeaders, maxPayload: tmpMaxPayloadMB * 1024 * 1024 });
		}
		catch (pError)
		{
			return fCallback(new Error('Failed to create WebSocket connection: ' + pError.message));
		}

		let tmpCallbackFired = false;

		this._WebSocket.on('open', () =>
		{
			this.log.info(`[Beacon] WebSocket connected to ${tmpWSURL}`);

			// Register over WebSocket
			let tmpWSRegPayload = {
				Action: 'BeaconRegister',
				Name: this._Config.Name,
				Capabilities: this._Executor.providerRegistry.getCapabilities(),
				ActionSchemas: this._Executor.providerRegistry.getActionSchemas(),
				MaxConcurrent: this._Config.MaxConcurrent,
				Tags: this._Config.Tags
			};
			// Optional join secret for non-promiscuous mode. Always sent
			// when configured — ultravisor decides whether to consult it.
			// Empty config = nothing on the wire (the field is omitted)
			// to keep promiscuous-mode payloads exactly as before.
			if (this._Config.JoinSecret)
			{
				tmpWSRegPayload.JoinSecret = this._Config.JoinSecret;
			}
			if (this._Config.Contexts && Object.keys(this._Config.Contexts).length > 0)
			{
				tmpWSRegPayload.Contexts = this._Config.Contexts;
			}
			if (Array.isArray(this._Config.Operations) && this._Config.Operations.length > 0)
			{
				tmpWSRegPayload.Operations = this._Config.Operations;
			}
			if (Array.isArray(this._Config.BindAddresses) && this._Config.BindAddresses.length > 0)
			{
				tmpWSRegPayload.BindAddresses = this._Config.BindAddresses;
			}
			// Shared-fs identity must be sent on the WebSocket registration path
			// too — most beacons connect via WebSocket now and the HTTP _register
			// payload is only used for the initial probe / fallback. Without
			// this, the coordinator stores the beacon record with HostID=null
			// and the reachability auto-detect can't find it as a peer.
			tmpWSRegPayload.HostID = this._Config.HostID || libOS.hostname();
			tmpWSRegPayload.SharedMounts = this._normalizeSharedMounts(this._Config.SharedMounts);

			// Diagnostic: log the shared-fs fields being sent at LogNoisiness>=2.
			// If the coordinator later reports the beacon as having no HostID,
			// this log line is the definitive proof of what the client actually
			// transmitted. Without this, we can't tell whether a missing HostID
			// is a client-side bug (not sending) or a server-side bug (dropping).
			let tmpNoisy = (this._Config && this._Config.Log && this._Config.Log.LogNoisiness) ||
				(this.log && this.log.LogNoisiness) || 0;
			if (tmpNoisy >= 2)
			{
				this.log.info(`[Beacon] WS register payload HostID=${tmpWSRegPayload.HostID || '(none)'} SharedMounts=${JSON.stringify(tmpWSRegPayload.SharedMounts || [])}`);
			}

			this._wsSend(tmpWSRegPayload);
		});

		this._WebSocket.on('message', (pMessage) =>
		{
			this._handleWSMessage(pMessage, (pBeaconData) =>
			{
				// Registration response — fire the start callback once
				if (!tmpCallbackFired && pBeaconData)
				{
					tmpCallbackFired = true;
					this._Running = true;

					// Start heartbeat over WebSocket
					this._HeartbeatInterval = setInterval(() =>
					{
						this._wsHeartbeat();
					}, this._Config.HeartbeatIntervalMs);

					return fCallback(null, pBeaconData);
				}
			});
		});

		this._WebSocket.on('error', (pError) =>
		{
			this.log.error(`[Beacon] WebSocket error: ${pError.message}`);
			if (!tmpCallbackFired)
			{
				tmpCallbackFired = true;
				return fCallback(pError);
			}
		});

		this._WebSocket.on('close', () =>
		{
			this.log.info(`[Beacon] WebSocket connection closed.`);
			this._WebSocket = null;

			if (this._Running && !this._Authenticating && !this._ReconnectPending)
			{
				// Connection lost while running — attempt reconnect
				this._scheduleReconnect();
			}
		});
	}

	/**
	 * Handle an incoming WebSocket message from the Ultravisor server.
	 *
	 * @param {Buffer|string} pMessage - The raw message data.
	 * @param {function} fRegistrationCallback - Called with beacon data on registration.
	 */
	_handleWSMessage(pMessage, fRegistrationCallback)
	{
		let tmpData;
		try
		{
			tmpData = JSON.parse(pMessage.toString());
		}
		catch (pError)
		{
			return;
		}

		if (tmpData.EventType === 'BeaconRegistered')
		{
			this._BeaconID = tmpData.BeaconID;
			this.log.info(`[Beacon] Registered via WebSocket as ${this._BeaconID}`);
			if (typeof fRegistrationCallback === 'function')
			{
				fRegistrationCallback({ BeaconID: this._BeaconID });
			}
		}
		else if (tmpData.EventType === 'WorkItem' && tmpData.WorkItem)
		{
			if (this._ActiveWorkItems >= this._Config.MaxConcurrent)
			{
				this.log.info(`[Beacon] At max concurrent capacity, ignoring pushed work item.`);
				return;
			}
			this._executeWorkItem(tmpData.WorkItem);
		}
		else if (tmpData.EventType === 'Deregistered')
		{
			this.log.info(`[Beacon] Deregistered by server.`);
			this._BeaconID = null;
		}
	}

	/**
	 * Send a JSON message over the WebSocket.
	 *
	 * @param {object} pData - The data to send.
	 */
	_wsSend(pData)
	{
		if (this._WebSocket && this._WebSocket.readyState === libWebSocket.OPEN)
		{
			this._WebSocket.send(JSON.stringify(pData));
		}
	}

	/**
	 * Send a heartbeat over WebSocket.
	 */
	_wsHeartbeat()
	{
		if (!this._Running || !this._BeaconID)
		{
			return;
		}
		this._wsSend({ Action: 'BeaconHeartbeat', BeaconID: this._BeaconID });
	}

	/**
	 * Report work completion over WebSocket (falls back to HTTP if WS is closed).
	 */
	_wsReportComplete(pWorkItemHash, pOutputs, pLog)
	{
		if (this._WebSocket && this._WebSocket.readyState === libWebSocket.OPEN)
		{
			this._wsSend({
				Action: 'WorkComplete',
				WorkItemHash: pWorkItemHash,
				Outputs: pOutputs,
				Log: pLog
			});
		}
		else
		{
			// Fall back to HTTP
			this._reportComplete(pWorkItemHash, pOutputs, pLog);
		}
	}

	/**
	 * Report work error over WebSocket (falls back to HTTP if WS is closed).
	 */
	_wsReportError(pWorkItemHash, pErrorMessage, pLog)
	{
		if (this._WebSocket && this._WebSocket.readyState === libWebSocket.OPEN)
		{
			this._wsSend({
				Action: 'WorkError',
				WorkItemHash: pWorkItemHash,
				ErrorMessage: pErrorMessage,
				Log: pLog
			});
		}
		else
		{
			this._reportError(pWorkItemHash, pErrorMessage, pLog);
		}
	}

	/**
	 * Report work progress over WebSocket.
	 */
	_wsReportProgress(pWorkItemHash, pProgressData)
	{
		if (!pProgressData || !this._Running)
		{
			return;
		}
		if (this._WebSocket && this._WebSocket.readyState === libWebSocket.OPEN)
		{
			this._wsSend({
				Action: 'WorkProgress',
				WorkItemHash: pWorkItemHash,
				ProgressData: pProgressData
			});
		}
		else
		{
			this._reportProgress(pWorkItemHash, pProgressData);
		}
	}

	/**
	 * Schedule a reconnection with exponential backoff.
	 * Prevents multiple close events from triggering parallel reconnections.
	 */
	_scheduleReconnect()
	{
		if (this._ReconnectPending || this._Authenticating)
		{
			return;
		}

		this._ReconnectPending = true;
		this._ReconnectAttempts++;

		// Exponential backoff: 10s, 20s, 40s, 80s, 160s, capped at 5 min
		let tmpDelay = Math.min(
			this._Config.ReconnectIntervalMs * Math.pow(2, this._ReconnectAttempts - 1),
			this._MaxReconnectDelayMs);

		this.log.info(`[Beacon] Scheduling reconnection attempt ${this._ReconnectAttempts} in ${Math.round(tmpDelay / 1000)}s`);

		setTimeout(() =>
		{
			this._ReconnectPending = false;
			this._wsReconnect();
		}, tmpDelay);
	}

	/**
	 * Reconnect the WebSocket after unexpected disconnection.
	 * Falls back to HTTP polling if WebSocket can't be re-established.
	 */
	_wsReconnect()
	{
		if (this._Authenticating)
		{
			return;
		}
		this._Authenticating = true;

		if (this._HeartbeatInterval)
		{
			clearInterval(this._HeartbeatInterval);
			this._HeartbeatInterval = null;
		}

		this._SessionCookie = null;
		this.log.info(`[Beacon] Reconnecting — attempt ${this._ReconnectAttempts}...`);

		this._authenticate((pAuthError) =>
		{
			if (pAuthError)
			{
				this.log.error(`[Beacon] Re-authentication failed: ${pAuthError.message}`);
				this._Authenticating = false;
				this._scheduleReconnect();
				return;
			}

			this._Authenticating = false;

			// Try WebSocket again
			this._startWebSocket((pError, pBeacon) =>
			{
				if (pError)
				{
					// WebSocket failed — fall back to HTTP polling
					this.log.info(`[Beacon] WebSocket reconnection failed, falling back to HTTP polling.`);
					this._UseWebSocket = false;
					this._startHTTP((pHTTPError, pHTTPBeacon) =>
					{
						if (pHTTPError)
						{
							this.log.error(`[Beacon] HTTP fallback failed: ${pHTTPError.message}`);
							this._scheduleReconnect();
							return;
						}
						this._ReconnectAttempts = 0;
						this.log.info(`[Beacon] Reconnected via HTTP polling as ${pHTTPBeacon.BeaconID}`);
					});
					return;
				}
				this._ReconnectAttempts = 0;
				this.log.info(`[Beacon] WebSocket reconnected as ${pBeacon.BeaconID}`);
			});
		});
	}
}

module.exports = UltravisorBeaconClient;
