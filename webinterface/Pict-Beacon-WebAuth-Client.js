/**
 * Pict-Beacon-WebAuth-Client — pict-app helper for beacon login UIs
 *
 * Companion to Ultravisor-Beacon-WebAuth.cjs on the server side.  Any
 * beacon whose pict-app wants the same three-mode gate Ultravisor's UI
 * has (promiscuous → just works; authenticated → forced through login;
 * external-auth → in-app user mgmt hidden) imports this and calls
 * `install(pict, options)` from its application constructor.
 *
 * What this module does:
 *
 *   1. Registers `pict-section-login` as a view named `Pict-Section-Login`
 *      with endpoints + behaviour wired to the beacon's local proxy
 *      routes (which in turn talk to UV).  Mount target is the
 *      conventional `#Pict-Login-Container` div.
 *
 *   2. Monkey-patches `onLoginSuccess`/`onLogout`/`onSessionChecked` on
 *      the section instance so the host application's flow hooks run
 *      after the section's HTTP calls resolve (no subclass file needed).
 *
 *   3. Exposes `loadAuthStatus(callback)` for the host's
 *      `onAfterInitializeAsync` to fetch `/status` and populate
 *      `AppData.<AuthStateAddress>.Auth = { Mode, SupportsUserManagement,
 *      SessionChecked, Authenticated }`.  The host typically renders
 *      the layout after both this AND its task/data loading finish, then
 *      navigates to /Login when AuthMode === 'authenticated'.
 *
 * What this module does NOT do:
 *
 *   - Define a wrapper view (each beacon has its own ~20-line wrapper
 *     that paints `#Pict-Login-Container` inside its content panel).
 *   - Touch the host's router config.  The host adds a `/Login` route
 *     pointing at the wrapper view.
 *   - Force a particular AppData shape — `AuthStateAddress` is
 *     configurable so beacons that already use a nested namespace
 *     (e.g. `AppData.DataBeacon.Auth`) stay tidy.
 *
 * Usage:
 *
 *   const libBeaconWebAuthClient = require('ultravisor-beacon/webinterface/Pict-Beacon-WebAuth-Client.js');
 *
 *   libBeaconWebAuthClient.install(this.pict, {
 *       Section:              require('pict-section-login'),
 *       AuthStateAddress:     'AppData.DataBeacon.Auth',
 *       LoginRoute:           '/Login',
 *       HomeRoute:            '/Dashboard',
 *       StatusURL:            '/status',
 *       LoginEndpoint:        '/1.0/Authenticate',
 *       LogoutEndpoint:       '/1.0/Deauthenticate',
 *       CheckSessionEndpoint: '/1.0/CheckSession',
 *       OnAfterLogin:         (pSession) => app.refreshTopBarAndSidebar(),
 *       OnAfterLogout:        ()         => app.refreshTopBarAndSidebar(),
 *       OnSessionChecked:     (pSession) => { /* optional extra hook *\/ }
 *   });
 *
 * The Section module must be passed in by the host — this helper has
 * to live in a browser-loaded bundle so it can't require the pict
 * package at module-load time (the host's bundler resolves `pict-
 * section-login` against its own dependency tree).
 */

'use strict';

const DEFAULTS =
{
	SectionViewIdentifier: 'Pict-Section-Login',
	AuthStateAddress:      'AppData.Beacon.Auth',
	LoginRoute:            '/Login',
	HomeRoute:             '/Home',
	StatusURL:             '/status',
	LoginEndpoint:         '/1.0/Authenticate',
	LogoutEndpoint:        '/1.0/Deauthenticate',
	CheckSessionEndpoint:  '/1.0/CheckSession',
	CheckSessionOnLoad:    true,
	ShowOAuthProviders:    false
};

/**
 * Install the login section + return a small handle the host uses to
 * drive its boot gate.
 *
 * @param {object} pPict       — the live Pict instance
 * @param {object} pOptions    — see DEFAULTS for the full surface
 * @returns {object} handle    — { loadAuthStatus, navigateToLogin, ... }
 */
function install(pPict, pOptions)
{
	if (!pPict || typeof pPict.addView !== 'function')
	{
		throw new Error('Pict-Beacon-WebAuth-Client.install: pPict must be a Pict instance');
	}
	if (!pOptions || !pOptions.Section)
	{
		throw new Error('Pict-Beacon-WebAuth-Client.install: pOptions.Section (the pict-section-login module) is required');
	}

	let tmpConfig = Object.assign({}, DEFAULTS, pOptions);
	let libPictSectionLogin = tmpConfig.Section;

	// Register the section view.  CheckSessionOnLoad triggers the
	// section's automatic session validation on its first render —
	// which we use as the boot-gate's "is the cookie still good?" check.
	pPict.addView(tmpConfig.SectionViewIdentifier,
		{
			LoginEndpoint:        tmpConfig.LoginEndpoint,
			LogoutEndpoint:       tmpConfig.LogoutEndpoint,
			CheckSessionEndpoint: tmpConfig.CheckSessionEndpoint,
			CheckSessionOnLoad:   tmpConfig.CheckSessionOnLoad,
			ShowOAuthProviders:   tmpConfig.ShowOAuthProviders
		}, libPictSectionLogin);

	// Wire the section's overridable hooks to the host's flow.  Each
	// hook also keeps the auth-state slot in AppData in sync so any
	// view (top bar, sidebar, menus) can re-render off a single source.
	let tmpLogin = pPict.views[tmpConfig.SectionViewIdentifier];
	if (tmpLogin)
	{
		tmpLogin.onLoginSuccess   = (pSession) => _afterLogin(pPict, tmpConfig, pSession);
		tmpLogin.onLogout         = ()         => _afterLogout(pPict, tmpConfig);
		tmpLogin.onSessionChecked = (pSession) => _afterSessionChecked(pPict, tmpConfig, pSession);
	}

	// Seed the auth-state slot with defaults so views that render
	// before /status returns can read truthy/falsy values without
	// optional-chaining.
	_writeAuthState(pPict, tmpConfig,
		{
			Mode: 'promiscuous',
			SupportsUserManagement: false,
			SessionChecked: false,
			Authenticated: false
		});

	return {
		/**
		 * Fetch /status and refresh AppData auth state.  Hosts call this
		 * inside `onAfterInitializeAsync` alongside their task/data load
		 * so route resolution + layout render only happen once both are
		 * complete.  fCallback(pError) — `pError` is non-fatal; on
		 * failure we keep the seeded defaults (promiscuous) so the UI
		 * still renders.
		 */
		loadAuthStatus: function (fCallback)
		{
			fetch(tmpConfig.StatusURL, { credentials: 'include' })
				.then((pResp) => pResp.ok ? pResp.json() : Promise.reject(new Error('HTTP ' + pResp.status)))
				.then((pBody) =>
				{
					_writeAuthState(pPict, tmpConfig,
						{
							Mode: (pBody && pBody.AuthMode === 'authenticated') ? 'authenticated' : 'promiscuous',
							SupportsUserManagement: !!(pBody && pBody.SupportsUserManagement),
							SessionChecked: false,
							Authenticated: false
						});
					if (typeof fCallback === 'function') { fCallback(null, pBody); }
				})
				.catch((pErr) =>
				{
					if (typeof fCallback === 'function') { fCallback(pErr); }
				});
		},

		/**
		 * Convenience: navigate to the configured /Login route.  Hosts
		 * use this from their bootGate when /status reports authenticated
		 * mode + the section's CheckSessionOnLoad has not yet confirmed
		 * a valid cookie.
		 */
		navigateToLogin: function ()
		{
			if (pPict.PictApplication && typeof pPict.PictApplication.navigateTo === 'function')
			{
				pPict.PictApplication.navigateTo(tmpConfig.LoginRoute);
			}
			else if (pPict.providers && pPict.providers.PictRouter)
			{
				pPict.providers.PictRouter.navigate(tmpConfig.LoginRoute);
			}
		},

		/** True iff the user is currently authenticated (per local state). */
		isAuthenticated: function ()
		{
			let tmpState = _readAuthState(pPict, tmpConfig);
			return !!(tmpState && tmpState.Authenticated);
		},

		/** Current cached AuthMode. */
		getAuthMode: function ()
		{
			let tmpState = _readAuthState(pPict, tmpConfig);
			return (tmpState && tmpState.Mode) || 'promiscuous';
		},

		/** Direct accessor to the AppData auth state (for views/templates). */
		getAuthState: function () { return _readAuthState(pPict, tmpConfig); }
	};
}

// ────────────────────────────────────────────────────────────────────────
// Hooks fired by the section view
// ────────────────────────────────────────────────────────────────────────

function _afterLogin(pPict, pConfig, pSession)
{
	_writeAuthState(pPict, pConfig,
		Object.assign({}, _readAuthState(pPict, pConfig) || {},
			{ Authenticated: true, SessionChecked: true }));
	if (typeof pConfig.OnAfterLogin === 'function')
	{
		try { pConfig.OnAfterLogin(pSession); } catch (pErr) { _warn(pPict, pErr); }
	}
	_safeNavigate(pPict, pConfig, pConfig.HomeRoute);
}

function _afterLogout(pPict, pConfig)
{
	_writeAuthState(pPict, pConfig,
		Object.assign({}, _readAuthState(pPict, pConfig) || {},
			{ Authenticated: false }));
	if (typeof pConfig.OnAfterLogout === 'function')
	{
		try { pConfig.OnAfterLogout(); } catch (pErr) { _warn(pPict, pErr); }
	}
	_safeNavigate(pPict, pConfig, pConfig.LoginRoute);
}

function _afterSessionChecked(pPict, pConfig, pSession)
{
	let tmpLoggedIn = !!(pSession && pSession.LoggedIn);
	_writeAuthState(pPict, pConfig,
		Object.assign({}, _readAuthState(pPict, pConfig) || {},
			{ SessionChecked: true, Authenticated: tmpLoggedIn }));
	if (typeof pConfig.OnSessionChecked === 'function')
	{
		try { pConfig.OnSessionChecked(pSession); } catch (pErr) { _warn(pPict, pErr); }
	}
	// Only redirect away from the login view when the user is currently
	// looking at it (boot gate forced them there) AND auth-mode is on
	// (otherwise we have no business bouncing them anywhere).  We read
	// mode from AppData rather than pConfig because the gate hydrates
	// the state at runtime via loadAuthStatus().
	let tmpState = _readAuthState(pPict, pConfig) || {};
	let tmpOnLogin = (pPict.AppData && pPict.AppData.CurrentView === 'Login')
		|| _currentHashRoute() === pConfig.LoginRoute
		|| _currentHashRoute() === '/' + pConfig.LoginRoute;
	if (tmpLoggedIn && tmpState.Mode === 'authenticated' && tmpOnLogin)
	{
		_safeNavigate(pPict, pConfig, pConfig.HomeRoute);
	}
}

// ────────────────────────────────────────────────────────────────────────
// AppData address resolution
// ────────────────────────────────────────────────────────────────────────

function _readAuthState(pPict, pConfig)
{
	let tmpParts = String(pConfig.AuthStateAddress || '').split('.');
	let tmpCursor = pPict;
	for (let i = 0; i < tmpParts.length; i++)
	{
		if (!tmpCursor || typeof tmpCursor !== 'object') { return null; }
		tmpCursor = tmpCursor[tmpParts[i]];
	}
	return tmpCursor || null;
}

function _writeAuthState(pPict, pConfig, pValue)
{
	let tmpParts = String(pConfig.AuthStateAddress || '').split('.');
	if (tmpParts.length === 0) { return; }
	let tmpCursor = pPict;
	for (let i = 0; i < tmpParts.length - 1; i++)
	{
		let tmpKey = tmpParts[i];
		if (!tmpCursor[tmpKey] || typeof tmpCursor[tmpKey] !== 'object')
		{
			tmpCursor[tmpKey] = {};
		}
		tmpCursor = tmpCursor[tmpKey];
	}
	tmpCursor[tmpParts[tmpParts.length - 1]] = pValue;
}

// ────────────────────────────────────────────────────────────────────────
// Misc
// ────────────────────────────────────────────────────────────────────────

function _safeNavigate(pPict, pConfig, pRoute)
{
	if (!pRoute) { return; }
	if (pPict.PictApplication && typeof pPict.PictApplication.navigateTo === 'function')
	{
		pPict.PictApplication.navigateTo(pRoute);
	}
	else if (pPict.providers && pPict.providers.PictRouter
		&& typeof pPict.providers.PictRouter.navigate === 'function')
	{
		pPict.providers.PictRouter.navigate(pRoute);
	}
}

function _currentHashRoute()
{
	if (typeof window === 'undefined' || !window.location) { return ''; }
	let tmpHash = window.location.hash || '';
	if (tmpHash.charAt(0) === '#') { tmpHash = tmpHash.slice(1); }
	return tmpHash || '/';
}

function _warn(pPict, pErr)
{
	let tmpLog = (pPict && pPict.log) || console;
	let tmpFn = (tmpLog && (tmpLog.warn || tmpLog.error)) || console.warn;
	tmpFn('[Pict-Beacon-WebAuth-Client] hook threw: ' + ((pErr && pErr.message) || pErr));
}

module.exports = { install };
