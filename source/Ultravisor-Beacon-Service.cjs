/**
 * Ultravisor Beacon Service
 *
 * A Fable service that turns any Fable/Pict application into an
 * Ultravisor beacon.  Host applications register capabilities
 * (with action handlers), then call enable() to connect to an
 * Ultravisor server and begin accepting remote work items.
 *
 * Beacon mode is opt-in and disabled by default.
 *
 * This service composes three internal components:
 *   - CapabilityManager: stores registered capabilities
 *   - ConnectivityHTTP: HTTP transport configuration
 *   - BeaconClient (thin client): handles polling, auth, heartbeat
 *
 * Usage:
 *   let libBeaconService = require('ultravisor-beacon');
 *   pFable.addAndInstantiateServiceType('UltravisorBeacon', libBeaconService, {
 *     ServerURL: 'http://localhost:54321',
 *     Name: 'my-app-beacon'
 *   });
 *   let tmpBeacon = pFable.services.UltravisorBeacon;
 *   tmpBeacon.registerCapability({ Capability: 'MyApp', actions: { ... } });
 *   tmpBeacon.enable(function(pError) { ... });
 */

const libFableServiceBase = require('fable-serviceproviderbase');

const libBeaconClient = require('./Ultravisor-Beacon-Client.cjs');
const libCapabilityManager = require('./Ultravisor-Beacon-CapabilityManager.cjs');
const libConnectivityHTTP = require('./Ultravisor-Beacon-ConnectivityHTTP.cjs');
const libConnectivityWebSocket = require('./Ultravisor-Beacon-ConnectivityWebSocket.cjs');
const libAddressResolver = require('./Ultravisor-Beacon-AddressResolver.cjs');

class UltravisorBeaconService extends libFableServiceBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		super(pFable, pOptions, pServiceHash);

		this.serviceType = 'UltravisorBeacon';

		// Merge defaults
		this.options = Object.assign({
			Enabled: false,
			ServerURL: 'http://localhost:54321',
			Name: '',
			Password: '',
			MaxConcurrent: 1,
			PollIntervalMs: 5000,
			HeartbeatIntervalMs: 30000,
			StagingPath: '',
			Tags: {},
			Contexts: {},
			HostID: '',
			SharedMounts: []
		}, this.options || {});

		// Internal components
		this._CapabilityManager = new libCapabilityManager();
		this._ConnectivityService = new libConnectivityHTTP(this.options);
		this._AddressResolver = new libAddressResolver();
		this._ThinClient = null;
		this._Enabled = false;

		// Operation definitions to register with the coordinator on connect
		this._Operations = [];
	}

	// ================================================================
	// Public API
	// ================================================================

	/**
	 * Register a capability from the host application.
	 *
	 * @param {object} pDescriptor - Capability descriptor:
	 *   {
	 *     Capability: 'ContentSystem',
	 *     Name: 'ContentSystemProvider',
	 *     actions: {
	 *       'ReadFile': {
	 *         Description: 'Read a content file',
	 *         SettingsSchema: [{ Name: 'FilePath', DataType: 'String', Required: true }],
	 *         Handler: function(pWorkItem, pContext, fCallback, fReportProgress) { ... }
	 *       }
	 *     },
	 *     initialize: function(fCallback) { ... },   // optional
	 *     shutdown: function(fCallback) { ... }       // optional
	 *   }
	 * @returns {object} this (for chaining)
	 */
	registerCapability(pDescriptor)
	{
		this._CapabilityManager.registerCapability(pDescriptor);

		if (this.log)
		{
			this.log.info(`UltravisorBeacon: registered capability [${pDescriptor.Capability}]`);
		}

		// If the beacon is already enabled (i.e., capabilities are
		// being registered AFTER initial connect — e.g. from the
		// Readvertise hook in retold-labs-worker after a model push
		// finalize), push the new capability into the live thin
		// client's provider registry AND trigger a re-registration so
		// the hub's view of this beacon's capability list updates.
		// Without this, the worker holds the new handler locally but
		// the hub never routes work to it because its registry still
		// reflects the original enable() snapshot.
		if (this._Enabled && this._ThinClient)
		{
			this._refreshThinClientCapabilities();
		}

		return this;
	}

	/**
	 * Rebuild the thin client's provider registry from the current
	 * CapabilityManager state and trigger a re-registration POST so
	 * the hub's beacon record reflects any post-enable capability
	 * changes.
	 *
	 * Called automatically after `registerCapability()` (when already
	 * enabled) and `removeCapability()`. Callers can also invoke
	 * directly when they've batch-mutated capabilities.
	 */
	_refreshThinClientCapabilities()
	{
		if (!this._ThinClient || !this._ThinClient._Executor
			|| !this._ThinClient._Executor.providerRegistry)
		{
			return;
		}

		let tmpRegistry = this._ThinClient._Executor.providerRegistry;
		let tmpAdapters = this._CapabilityManager.buildProviderDescriptors();

		// Best-effort wipe + reload. Different registry versions expose
		// different APIs (clear / removeAllProviders / iterate via
		// getProviders + removeProvider). Try each in sequence.
		try
		{
			if (typeof tmpRegistry.removeAllProviders === 'function')
			{
				tmpRegistry.removeAllProviders();
			}
			else if (typeof tmpRegistry.clear === 'function')
			{
				tmpRegistry.clear();
			}
			else if (typeof tmpRegistry.getCapabilityNames === 'function'
				&& typeof tmpRegistry.removeProvider === 'function')
			{
				let tmpExisting = tmpRegistry.getCapabilityNames();
				for (let tmpName of tmpExisting)
				{
					try { tmpRegistry.removeProvider(tmpName); } catch (e) {}
				}
			}
		}
		catch (pClearErr)
		{
			if (this.log) this.log.warn(
				`UltravisorBeacon: capability re-load — failed to clear thin client registry: ${pClearErr.message}`);
		}

		for (let tmpAdapter of tmpAdapters)
		{
			try
			{
				tmpRegistry.registerProvider(tmpAdapter);
				if (typeof tmpAdapter.initialize === 'function')
				{
					try { tmpAdapter.initialize(() => {}); } catch (e) {}
				}
			}
			catch (pErr)
			{
				if (this.log) this.log.warn(
					`UltravisorBeacon: failed to inject [${tmpAdapter.Capability || '?'}] into thin client: ${pErr.message}`);
			}
		}

		if (typeof this._ThinClient.refreshRegistration === 'function')
		{
			this._ThinClient.refreshRegistration((pErr) =>
			{
				if (pErr && this.log)
				{
					this.log.warn(`UltravisorBeacon: refreshRegistration failed: ${pErr.message}`);
				}
				else if (this.log)
				{
					this.log.info(
						`UltravisorBeacon: re-registered with hub — `
						+ `capabilities now [${this._CapabilityManager.getCapabilityNames().join(', ')}]`);
				}
			});
		}
	}

	/**
	 * Register an operation definition to push to the coordinator on connect.
	 *
	 * Operation definitions use the same graph structure as HypervisorState
	 * operations (Hash, Name, Description, Graph with Nodes and Connections).
	 * These are sent during beacon registration and stored by the coordinator.
	 *
	 * @param {object} pOperationDef - Operation definition:
	 *   {
	 *     Hash: 'video-ingest',
	 *     Name: 'Video Ingest Pipeline',
	 *     Description: '...',
	 *     Graph: { Nodes: [...], Connections: [...] }
	 *   }
	 * @returns {object} this (for chaining)
	 */
	registerOperation(pOperationDef)
	{
		if (!pOperationDef || typeof(pOperationDef) !== 'object')
		{
			if (this.log)
			{
				this.log.warn('UltravisorBeacon: registerOperation requires a valid object.');
			}
			return this;
		}

		this._Operations.push(pOperationDef);

		if (this.log)
		{
			this.log.info(`UltravisorBeacon: registered operation [${pOperationDef.Hash || 'auto'}] "${pOperationDef.Name || ''}"`);
		}

		return this;
	}

	/**
	 * Remove a previously registered capability.
	 *
	 * @param {string} pCapabilityName
	 * @returns {object} this (for chaining)
	 */
	removeCapability(pCapabilityName)
	{
		this._CapabilityManager.removeCapability(pCapabilityName);
		return this;
	}

	/**
	 * Get the list of registered capability names.
	 *
	 * @returns {string[]}
	 */
	getCapabilityNames()
	{
		return this._CapabilityManager.getCapabilityNames();
	}

	/**
	 * Register a data context that this beacon exposes.
	 *
	 * Contexts define namespaces for the Universal Data Addressing scheme.
	 * For example, a retold-remote beacon might expose a 'File' context
	 * (content root) and a 'Cache' context (thumbnail cache).
	 *
	 * @param {string} pContextName - The context name (e.g. 'File', 'Cache', 'Staging').
	 * @param {object} pContextDef - Context definition:
	 *   {
	 *     BasePath: '/absolute/path',     // Local filesystem path
	 *     BaseURL: '/content/',           // URL prefix for remote access
	 *     Writable: true,                 // Whether remote writes are allowed
	 *     Description: 'Content root'     // Human-readable description
	 *   }
	 * @returns {object} this (for chaining)
	 */
	registerContext(pContextName, pContextDef)
	{
		this.options.Contexts[pContextName] = pContextDef;

		// Also register with the address resolver for local resolution
		if (pContextDef.BasePath)
		{
			this._AddressResolver.setLocalContextPath(pContextName, pContextDef.BasePath);
		}

		if (this.log)
		{
			this.log.info(`UltravisorBeacon: registered context [${pContextName}]`);
		}

		return this;
	}

	/**
	 * Get the address resolver instance.
	 *
	 * @returns {UltravisorBeaconAddressResolver}
	 */
	getAddressResolver()
	{
		return this._AddressResolver;
	}

	/**
	 * Enable beacon mode: build providers, create thin client, connect.
	 *
	 * @param {function} fCallback - function(pError, pBeacon)
	 */
	enable(fCallback)
	{
		if (this._Enabled)
		{
			if (this.log)
			{
				this.log.warn('UltravisorBeacon: already enabled.');
			}
			return fCallback(null);
		}

		// Determine beacon name
		let tmpName = this.options.Name;
		if (!tmpName && this.fable && this.fable.settings && this.fable.settings.Product)
		{
			tmpName = this.fable.settings.Product;
		}
		if (!tmpName)
		{
			tmpName = 'beacon-worker';
		}

		// Build adapter instances from registered capabilities
		let tmpAdapters = this._CapabilityManager.buildProviderDescriptors();

		if (tmpAdapters.length === 0)
		{
			if (this.log)
			{
				this.log.warn('UltravisorBeacon: no capabilities registered. Beacon will have no providers.');
			}
		}

		// Get transport config
		let tmpTransportConfig = this._ConnectivityService.getTransportConfig();

		// Build thin client config
		let tmpClientConfig = Object.assign({}, tmpTransportConfig, {
			Name: tmpName,
			MaxConcurrent: this.options.MaxConcurrent || 1,
			StagingPath: this.options.StagingPath || process.cwd(),
			Tags: this.options.Tags || {},
			Contexts: this.options.Contexts || {},
			BindAddresses: this.options.BindAddresses || [],
			Operations: this._Operations.length > 0 ? this._Operations : undefined,
			Log: this.log,
			// Pass empty Providers array — we'll register adapters directly
			Providers: []
		});

		// Shared-fs identity (forwarded to the thin client which sends it to the
		// coordinator at registration time so the reachability matrix can detect
		// beacons that share a filesystem on the same host).
		if (this.options.HostID)
		{
			tmpClientConfig.HostID = this.options.HostID;
		}
		if (Array.isArray(this.options.SharedMounts) && this.options.SharedMounts.length > 0)
		{
			tmpClientConfig.SharedMounts = this.options.SharedMounts;
		}

		// Create thin client
		this._ThinClient = new libBeaconClient(tmpClientConfig);

		// Register each adapter directly with the thin client's provider registry
		for (let i = 0; i < tmpAdapters.length; i++)
		{
			this._ThinClient._Executor.providerRegistry.registerProvider(tmpAdapters[i]);
		}

		if (this.log)
		{
			this.log.info(`UltravisorBeacon: enabling beacon "${tmpName}" → ${tmpTransportConfig.ServerURL}`);
			this.log.info(`UltravisorBeacon: capabilities: [${this._CapabilityManager.getCapabilityNames().join(', ')}]`);
		}

		// Start the thin client (authenticate, register, begin polling)
		this._ThinClient.start((pError, pBeacon) =>
		{
			if (pError)
			{
				this._ThinClient = null;
				if (this.log)
				{
					this.log.error(`UltravisorBeacon: enable failed: ${pError.message}`);
				}
				return fCallback(pError);
			}

			this._Enabled = true;
			this._AddressResolver.setLocalBeaconID(pBeacon.BeaconID);

			if (this.log)
			{
				this.log.info(`UltravisorBeacon: enabled as ${pBeacon.BeaconID}`);
			}

			return fCallback(null, pBeacon);
		});
	}

	/**
	 * Disable beacon mode: stop polling, deregister, disconnect.
	 *
	 * @param {function} fCallback - function(pError)
	 */
	disable(fCallback)
	{
		if (!this._Enabled || !this._ThinClient)
		{
			if (this.log)
			{
				this.log.warn('UltravisorBeacon: not enabled.');
			}
			return fCallback(null);
		}

		if (this.log)
		{
			this.log.info('UltravisorBeacon: disabling...');
		}

		this._ThinClient.stop((pError) =>
		{
			this._Enabled = false;
			this._ThinClient = null;

			if (pError && this.log)
			{
				this.log.warn(`UltravisorBeacon: disable warning: ${pError.message}`);
			}
			else if (this.log)
			{
				this.log.info('UltravisorBeacon: disabled.');
			}

			return fCallback(pError || null);
		});
	}

	/**
	 * Check if beacon mode is currently enabled.
	 *
	 * @returns {boolean}
	 */
	isEnabled()
	{
		return this._Enabled;
	}

	/**
	 * Get the underlying thin client instance (for advanced usage).
	 * Returns null if beacon is not enabled.
	 *
	 * @returns {object|null}
	 */
	getThinClient()
	{
		return this._ThinClient;
	}

	/**
	 * Convenience accessor for the BeaconID assigned by Ultravisor at
	 * registration time.  Returns null until enable() has completed
	 * successfully (and after disable()).  Useful for things like the
	 * WebAuth helper, which stamps the BeaconID into `RequestingBeacon`
	 * on every login/logout proxied to UV.
	 */
	getBeaconID()
	{
		return (this._ThinClient && this._ThinClient._BeaconID) || null;
	}

	/**
	 * Get the capability manager instance.
	 *
	 * @returns {object}
	 */
	getCapabilityManager()
	{
		return this._CapabilityManager;
	}
}

module.exports = UltravisorBeaconService;

// Also export sub-components for direct usage
module.exports.BeaconClient = libBeaconClient;
module.exports.CapabilityManager = libCapabilityManager;
module.exports.CapabilityAdapter = require('./Ultravisor-Beacon-CapabilityAdapter.cjs');
module.exports.CapabilityProvider = require('./Ultravisor-Beacon-CapabilityProvider.cjs');
module.exports.ProviderRegistry = require('./Ultravisor-Beacon-ProviderRegistry.cjs');
module.exports.AddressResolver = libAddressResolver;
module.exports.ConnectivityHTTP = libConnectivityHTTP;
module.exports.ConnectivityWebSocket = libConnectivityWebSocket;
// Opt-in web-UI auth helper for beacons that host an HTTP UI and want
// to proxy login through their paired Ultravisor.  See
// Ultravisor-Beacon-WebAuth.cjs for the install signature.
module.exports.WebAuth = require('./Ultravisor-Beacon-WebAuth.cjs');
