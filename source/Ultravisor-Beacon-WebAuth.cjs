/**
 * Ultravisor-Beacon-WebAuth — opt-in web-UI session gating for beacons
 *
 * A beacon embeds its own HTTP server (Orator/Restify) to host a web
 * UI.  When the Ultravisor it's connected to is in non-promiscuous
 * mode, the beacon's UI needs to require login.  This module is the
 * one-line opt-in: a beacon calls `install(orator, options)` after
 * its Orator server is up, and gets:
 *
 *   - POST /1.0/Authenticate       (proxies to UV; mints a beacon-scoped cookie)
 *   - POST /1.0/Deauthenticate     (proxies to UV; clears the cookie)
 *   - GET  /1.0/CheckSession       (validates the beacon cookie against UV)
 *   - GET  /status                 (proxies UV's /status + appends BeaconName, BeaconID)
 *   - middleware on GatedPathPrefixes that 401s unauthenticated requests
 *     when UV says we're in authenticated mode, synthesizes anonymous in
 *     promiscuous mode (matches Ultravisor's own _requireSession behavior)
 *
 * Session model — TWO-TIER:
 *
 *   browser ⇄ beacon  : cookie value is a beacon-minted opaque UUID
 *                       (`BeaconSessionID`) stored in the in-process
 *                       `BeaconSessionStore`.
 *   beacon  ⇄ UV      : cookie value is UV's own SessionID, captured
 *                       on /1.0/Authenticate and stored alongside the
 *                       BeaconSessionID in the local Map.
 *
 * UV remains the single source of truth.  Logout on the beacon calls
 * UV's /1.0/Deauthenticate with the mapped UV SessionID; if UV says
 * "not logged in" on any CheckSession, the beacon drops its local
 * mapping.  Browser tokens never carry UV's identifier — an attacker
 * who steals the beacon cookie can only act against that beacon.
 *
 * State is in-memory (per-process); a beacon restart logs everyone out.
 * That's acceptable for v1 — sessions are short-lived and UV's audit
 * trail captures the login regardless.  A future swap to a pluggable
 * BeaconSessionStore (Redis, SQLite) doesn't change the public surface.
 */

'use strict';

const libCrypto = require('crypto');
const libHTTP = require('http');
const libHTTPS = require('https');
const libURL = require('url');

const DEFAULTS =
{
	CookieName:        'SessionID',
	RoutePrefix:       '/1.0/',
	StatusPath:        '/status',
	GatedPathPrefixes: [],         // empty = no global gate (only the auth routes themselves are mounted)
	SessionCacheMs:    30 * 1000,  // how long a CheckSession result is trusted before re-asking UV
	UltravisorTimeoutMs: 8000,
	SweepIntervalMs:   60 * 1000   // periodic prune of expired entries
};

// ────────────────────────────────────────────────────────────────────────
// Module-private state — one instance per Orator the helper is installed on.
// Keyed by the Orator's serviceServer object identity so a process hosting
// multiple beacons (unusual but supported) gets isolated state per beacon.
// ────────────────────────────────────────────────────────────────────────
const _Installs = new WeakMap();

/**
 * Install web-UI auth routes + middleware on a beacon's Orator server.
 *
 * @param {object} pOrator
 *   The OratorServiceServer (Restify wrapper) the beacon uses to serve
 *   its UI.  Must expose `.server` (the underlying restify instance) so
 *   we can mount routes + chain a global `use()` middleware.
 *
 * @param {object} pOptions
 *   {
 *     UltravisorURL:        string,   // required — the UV this beacon is paired with
 *     BeaconName:           string,   // required — appears in RequestingBeacon
 *     BeaconID:             string | () => string,   // optional, looked up lazily
 *     CookieName:           string,   // default 'SessionID'
 *     RoutePrefix:          string,   // default '/1.0/'
 *     StatusPath:           string,   // default '/status'
 *     GatedPathPrefixes:    string[], // routes that 401 in authenticated mode without a session
 *     SessionCacheMs:       number,
 *     UltravisorTimeoutMs:  number,
 *     Log:                  object    // optional fable-style logger
 *   }
 *
 * @returns {object}
 *   { uninstall: () => void, getStore: () => Map, getAuthMode: () => 'promiscuous'|'authenticated'|'unknown' }
 *   so tests + hot-reload scenarios can inspect / dismantle the install.
 */
function install(pOrator, pOptions)
{
	if (!pOrator || !pOrator.serviceServer)
	{
		throw new Error('Ultravisor-Beacon-WebAuth.install: pOrator must be an OratorServiceServer with a serviceServer property');
	}
	if (!pOptions || typeof pOptions !== 'object')
	{
		throw new Error('Ultravisor-Beacon-WebAuth.install: pOptions is required');
	}
	if (!pOptions.UltravisorURL)
	{
		throw new Error('Ultravisor-Beacon-WebAuth.install: pOptions.UltravisorURL is required');
	}
	if (!pOptions.BeaconName)
	{
		throw new Error('Ultravisor-Beacon-WebAuth.install: pOptions.BeaconName is required');
	}

	let tmpServer = pOrator.serviceServer;
	let tmpConfig = Object.assign({}, DEFAULTS, pOptions);
	if (tmpConfig.RoutePrefix.charAt(tmpConfig.RoutePrefix.length - 1) !== '/')
	{
		tmpConfig.RoutePrefix += '/';
	}

	let tmpLog = pOptions.Log || console;

	// BeaconSessionStore: Map<BeaconSessionID, { UVSessionID, UserContext, ExpiresAt, RefreshedAt }>
	// In-process; cleared on restart.  Sweep periodically to keep the
	// memory footprint bounded even with churning short-lived sessions.
	let tmpStore = new Map();
	let tmpSweepHandle = setInterval(() =>
		{
			let tmpNow = Date.now();
			tmpStore.forEach((tmpEntry, tmpKey) =>
				{
					if (tmpEntry.ExpiresAt && tmpEntry.ExpiresAt < tmpNow)
					{
						tmpStore.delete(tmpKey);
					}
				});
		}, tmpConfig.SweepIntervalMs);
	if (tmpSweepHandle && typeof tmpSweepHandle.unref === 'function') { tmpSweepHandle.unref(); }

	// Cache the last-known auth mode from UV's /status so the gate
	// middleware can decide synchronously whether to 401 or pass through.
	// Refreshed lazily by /status proxy hits + a background poll.
	let tmpMode =
	{
		Value: 'unknown',
		LastRefreshed: 0
	};
	let _refreshModeFromStatus = (pResp) =>
	{
		if (pResp && pResp.AuthMode === 'authenticated') { tmpMode.Value = 'authenticated'; }
		else if (pResp && pResp.AuthMode === 'promiscuous') { tmpMode.Value = 'promiscuous'; }
		tmpMode.LastRefreshed = Date.now();
	};

	let _getBeaconID = () =>
		{
			if (typeof pOptions.BeaconID === 'function')
			{
				try { return pOptions.BeaconID() || ''; } catch (pErr) { return ''; }
			}
			return pOptions.BeaconID || '';
		};
	let _requestingBeacon = (pReq) =>
		({
			Name:      pOptions.BeaconName,
			BeaconID:  _getBeaconID(),
			UserAgent: (pReq && pReq.headers && pReq.headers['user-agent']) || ''
		});

	// ────────────────────────────────────────────────────────────────
	// HTTP client (UV proxy) — pared-down version of the SDK's
	// Beacon-Client._httpRequest pattern.  No auto-reconnect; we want
	// per-call cookies (the user's, not the beacon-client's stored one).
	// ────────────────────────────────────────────────────────────────
	let _callUltravisor = (pMethod, pPath, pCookie, pBody, fCallback) =>
	{
		let tmpParsed;
		try { tmpParsed = new libURL.URL(tmpConfig.UltravisorURL); }
		catch (pErr) { return fCallback(new Error(`Invalid UltravisorURL: ${tmpConfig.UltravisorURL}`)); }

		let tmpHTTPLib = (tmpParsed.protocol === 'https:') ? libHTTPS : libHTTP;
		let tmpOpts =
			{
				hostname: tmpParsed.hostname,
				port:     tmpParsed.port || (tmpParsed.protocol === 'https:' ? 443 : 80),
				path:     pPath,
				method:   pMethod,
				headers:  { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				timeout:  tmpConfig.UltravisorTimeoutMs
			};
		if (pCookie) { tmpOpts.headers['Cookie'] = pCookie; }

		let tmpReq = tmpHTTPLib.request(tmpOpts, (pResp) =>
		{
			let tmpData = '';
			pResp.on('data', (pChunk) => { tmpData += pChunk; });
			pResp.on('end', () =>
			{
				let tmpBodyParsed = null;
				if (tmpData)
				{
					try { tmpBodyParsed = JSON.parse(tmpData); }
					catch (pParseErr)
					{
						return fCallback(new Error(`Ultravisor returned non-JSON (${pResp.statusCode}): ${tmpData.slice(0, 200)}`));
					}
				}
				return fCallback(null,
					{
						StatusCode: pResp.statusCode,
						Headers:    pResp.headers || {},
						Body:       tmpBodyParsed
					});
			});
		});
		tmpReq.on('error', (pErr) => fCallback(pErr));
		tmpReq.on('timeout', () => { tmpReq.destroy(new Error('Ultravisor request timed out')); });

		if (pBody && (pMethod === 'POST' || pMethod === 'PUT'))
		{
			tmpReq.write(JSON.stringify(pBody));
		}
		tmpReq.end();
	};

	// ────────────────────────────────────────────────────────────────
	// Cookie helpers
	// ────────────────────────────────────────────────────────────────
	let _readCookie = (pReq) =>
	{
		let tmpHeader = pReq && pReq.headers && pReq.headers.cookie;
		if (!tmpHeader) { return ''; }
		let tmpParts = String(tmpHeader).split(';');
		for (let i = 0; i < tmpParts.length; i++)
		{
			let tmpKV = tmpParts[i].trim().split('=');
			if (tmpKV.length >= 2 && tmpKV[0] === tmpConfig.CookieName)
			{
				return tmpKV.slice(1).join('=');
			}
		}
		return '';
	};
	let _setCookie = (pResp, pValue, pMaxAgeSec) =>
	{
		let tmpParts =
			[
				`${tmpConfig.CookieName}=${pValue}`,
				'Path=/',
				'HttpOnly',
				'SameSite=Strict'
			];
		if (Number.isFinite(pMaxAgeSec) && pMaxAgeSec > 0) { tmpParts.push(`Max-Age=${pMaxAgeSec}`); }
		_setHeader(pResp, 'Set-Cookie', tmpParts.join('; '));
	};
	let _clearCookie = (pResp) =>
	{
		_setHeader(pResp, 'Set-Cookie',
			`${tmpConfig.CookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
	};
	let _setHeader = (pResp, pName, pValue) =>
	{
		// Restify uses `header()`; bare node uses `setHeader()`.  Try both.
		if (typeof pResp.header === 'function') { pResp.header(pName, pValue); }
		else if (typeof pResp.setHeader === 'function') { pResp.setHeader(pName, pValue); }
	};

	// ────────────────────────────────────────────────────────────────
	// Route handlers
	// ────────────────────────────────────────────────────────────────
	let _handleAuthenticate = (pRequest, pResponse, fNext) =>
	{
		let tmpBody = pRequest.body || {};
		// Echo what orator-authentication accepts: UserName + Password,
		// either capitalization.  We do NOT validate locally — UV does.
		let tmpPayload =
			{
				UserName: tmpBody.UserName || tmpBody.username || '',
				Password: tmpBody.Password || tmpBody.password || '',
				RequestingBeacon: _requestingBeacon(pRequest)
			};
		_callUltravisor('POST', tmpConfig.RoutePrefix + 'Authenticate', null, tmpPayload,
			(pErr, pResult) =>
			{
				if (pErr || !pResult)
				{
					tmpLog.warn && tmpLog.warn(`[BeaconWebAuth] /Authenticate proxy failed: ${pErr && pErr.message}`);
					pResponse.send(502, { LoggedIn: false, Error: 'Ultravisor unreachable' });
					return fNext();
				}
				let tmpUVBody = pResult.Body || {};
				if (pResult.StatusCode !== 200 || !tmpUVBody.LoggedIn)
				{
					// Forward UV's rejection verbatim so the client can show
					// whatever reason orator-authentication produced.
					pResponse.send(pResult.StatusCode || 401, tmpUVBody);
					return fNext();
				}

				// Capture UV's SessionID from the Set-Cookie header (or
				// from the body's SessionID — orator-auth sets both).
				let tmpUVSessionID = tmpUVBody.SessionID || _extractSetCookieValue(pResult.Headers, tmpConfig.CookieName);
				if (!tmpUVSessionID)
				{
					pResponse.send(502, { LoggedIn: false, Error: 'Ultravisor did not return a session token' });
					return fNext();
				}

				let tmpBeaconSessionID = libCrypto.randomBytes(32).toString('hex');
				let tmpExpiresMs = _parseExpires(tmpUVBody);
				tmpStore.set(tmpBeaconSessionID,
					{
						UVSessionID:  tmpUVSessionID,
						UserContext:  tmpUVBody.UserRecord || null,
						ExpiresAt:    tmpExpiresMs,
						RefreshedAt:  Date.now()
					});

				let tmpMaxAgeSec = tmpExpiresMs ? Math.max(1, Math.floor((tmpExpiresMs - Date.now()) / 1000)) : 0;
				_setCookie(pResponse, tmpBeaconSessionID, tmpMaxAgeSec);

				// Mirror UV's response body but swap the SessionID for the
				// beacon-scoped one so the browser never sees UV's value.
				pResponse.send(200, Object.assign({}, tmpUVBody,
					{
						SessionID: tmpBeaconSessionID
					}));
				return fNext();
			});
	};

	let _handleCheckSession = (pRequest, pResponse, fNext) =>
	{
		let tmpBeaconSessionID = _readCookie(pRequest);
		if (!tmpBeaconSessionID)
		{
			pResponse.send(200, { LoggedIn: false });
			return fNext();
		}
		let tmpEntry = tmpStore.get(tmpBeaconSessionID);
		if (!tmpEntry)
		{
			_clearCookie(pResponse);
			pResponse.send(200, { LoggedIn: false });
			return fNext();
		}

		// Cached freshness check — avoid hammering UV for every page load.
		let tmpAgeMs = Date.now() - (tmpEntry.RefreshedAt || 0);
		if (tmpAgeMs < tmpConfig.SessionCacheMs)
		{
			pResponse.send(200,
				{
					LoggedIn:   true,
					SessionID:  tmpBeaconSessionID,
					UserRecord: tmpEntry.UserContext || null
				});
			return fNext();
		}

		// Cache stale → re-validate at UV.  If UV says "no" or errors,
		// drop the local mapping so the next request takes the fast path.
		_callUltravisor('GET', tmpConfig.RoutePrefix + 'CheckSession',
			`${tmpConfig.CookieName}=${tmpEntry.UVSessionID}`, null,
			(pErr, pResult) =>
			{
				if (pErr || !pResult || pResult.StatusCode !== 200 || !pResult.Body || !pResult.Body.LoggedIn)
				{
					tmpStore.delete(tmpBeaconSessionID);
					_clearCookie(pResponse);
					pResponse.send(200, { LoggedIn: false });
					return fNext();
				}
				tmpEntry.UserContext = pResult.Body.UserRecord || tmpEntry.UserContext;
				tmpEntry.RefreshedAt = Date.now();
				pResponse.send(200,
					{
						LoggedIn:   true,
						SessionID:  tmpBeaconSessionID,
						UserRecord: tmpEntry.UserContext || null
					});
				return fNext();
			});
	};

	let _handleDeauthenticate = (pRequest, pResponse, fNext) =>
	{
		let tmpBeaconSessionID = _readCookie(pRequest);
		_clearCookie(pResponse);

		if (!tmpBeaconSessionID)
		{
			pResponse.send(200, { LoggedIn: false });
			return fNext();
		}
		let tmpEntry = tmpStore.get(tmpBeaconSessionID);
		tmpStore.delete(tmpBeaconSessionID);
		if (!tmpEntry)
		{
			pResponse.send(200, { LoggedIn: false });
			return fNext();
		}
		// Forward to UV with the mapped UV cookie so the auth beacon
		// records the logout + the source session is invalidated.
		_callUltravisor('POST', tmpConfig.RoutePrefix + 'Deauthenticate',
			`${tmpConfig.CookieName}=${tmpEntry.UVSessionID}`, { RequestingBeacon: _requestingBeacon(pRequest) },
			(pErr, pResult) =>
			{
				// Even if UV roundtrip fails, we've cleared the beacon
				// cookie locally — the user is logged out from this
				// beacon's perspective.  Log the failure for diagnostics.
				if (pErr) { tmpLog.warn && tmpLog.warn(`[BeaconWebAuth] /Deauthenticate proxy: ${pErr.message}`); }
				pResponse.send(200, (pResult && pResult.Body) || { LoggedIn: false });
				return fNext();
			});
	};

	let _handleStatus = (pRequest, pResponse, fNext) =>
	{
		// Pass-through UV's /status + decorate with this beacon's identity.
		// If UV is unreachable, fall back to a minimal local payload so
		// the browser can still load and report "AuthMode unknown".
		_callUltravisor('GET', '/status', null, null,
			(pErr, pResult) =>
			{
				let tmpBaseStatus =
					(pResult && pResult.Body)
					|| { Status: 'Unknown', AuthMode: 'unknown', AuthEnabled: false, SupportsUserManagement: false };
				_refreshModeFromStatus(tmpBaseStatus);
				let tmpStatus = Object.assign({}, tmpBaseStatus,
					{
						BeaconName: pOptions.BeaconName,
						BeaconID:   _getBeaconID()
					});
				pResponse.send(200, tmpStatus);
				return fNext();
			});
	};

	// Mount the routes.  Restify's method names match orator-authentication.
	let tmpBase = tmpConfig.RoutePrefix;
	let _post = (tmpServer.postWithBodyParser || tmpServer.post).bind(tmpServer);
	_post(`${tmpBase}Authenticate`,   _handleAuthenticate);
	tmpServer.get(`${tmpBase}CheckSession`,   _handleCheckSession);
	_post(`${tmpBase}Deauthenticate`, _handleDeauthenticate);
	tmpServer.get(tmpConfig.StatusPath, _handleStatus);

	// Background-poll UV's /status once on install so the gate has
	// AuthMode available before the first browser hit.  Errors are
	// silent — the /status proxy handler will refresh on demand.
	_callUltravisor('GET', '/status', null, null,
		(pErr, pResult) =>
		{
			if (!pErr && pResult && pResult.Body) { _refreshModeFromStatus(pResult.Body); }
		});

	// Gate middleware: applied to GatedPathPrefixes.  In promiscuous
	// mode it's a no-op; in authenticated mode it 401s requests that
	// don't carry a valid beacon cookie.  Auth + status routes are
	// always exempt (otherwise login itself would 401).
	let _requireSession = (pRequest, pResponse, fNext) =>
	{
		let tmpPath = pRequest.url || '';
		// Strip query string for prefix matching.
		let tmpQIdx = tmpPath.indexOf('?');
		if (tmpQIdx >= 0) { tmpPath = tmpPath.slice(0, tmpQIdx); }

		// Auth + status surface is always public.
		if (tmpPath === tmpConfig.StatusPath
			|| tmpPath === `${tmpBase}Authenticate`
			|| tmpPath === `${tmpBase}Deauthenticate`
			|| tmpPath === `${tmpBase}CheckSession`)
		{
			return fNext();
		}

		let tmpGated = false;
		for (let i = 0; i < tmpConfig.GatedPathPrefixes.length; i++)
		{
			if (tmpPath.indexOf(tmpConfig.GatedPathPrefixes[i]) === 0) { tmpGated = true; break; }
		}
		if (!tmpGated) { return fNext(); }

		// Promiscuous mode: pass through.  (Cached value; refreshes via
		// /status proxy hits + the install-time poll.)
		if (tmpMode.Value !== 'authenticated') { return fNext(); }

		let tmpBeaconSessionID = _readCookie(pRequest);
		if (!tmpBeaconSessionID || !tmpStore.has(tmpBeaconSessionID))
		{
			pResponse.send(401, { Error: 'Authentication required.', LoggedIn: false });
			return fNext();
		}
		return fNext();
	};
	if (Array.isArray(tmpConfig.GatedPathPrefixes) && tmpConfig.GatedPathPrefixes.length > 0)
	{
		if (typeof tmpServer.use === 'function')
		{
			tmpServer.use(_requireSession);
		}
		else
		{
			tmpLog.warn && tmpLog.warn('[BeaconWebAuth] serviceServer does not expose use(); gate middleware not installed');
		}
	}

	let tmpHandle =
		{
			uninstall: () =>
			{
				clearInterval(tmpSweepHandle);
				tmpStore.clear();
				_Installs.delete(tmpServer);
			},
			getStore:    () => tmpStore,
			getAuthMode: () => tmpMode.Value,
			refreshAuthMode: (fCb) =>
			{
				_callUltravisor('GET', '/status', null, null, (pErr, pResult) =>
					{
						if (!pErr && pResult && pResult.Body) { _refreshModeFromStatus(pResult.Body); }
						if (fCb) { fCb(pErr, tmpMode.Value); }
					});
			}
		};
	_Installs.set(tmpServer, tmpHandle);
	return tmpHandle;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Pull a cookie value out of a Set-Cookie header (single string or
 * string array).  Used when UV mints the session and we need to peel
 * SessionID off the response.
 */
function _extractSetCookieValue(pHeaders, pCookieName)
{
	if (!pHeaders) { return ''; }
	let tmpRaw = pHeaders['set-cookie'] || pHeaders['Set-Cookie'];
	if (!tmpRaw) { return ''; }
	let tmpArr = Array.isArray(tmpRaw) ? tmpRaw : [tmpRaw];
	for (let i = 0; i < tmpArr.length; i++)
	{
		let tmpFirst = String(tmpArr[i]).split(';')[0].trim();
		let tmpEq = tmpFirst.indexOf('=');
		if (tmpEq > 0 && tmpFirst.slice(0, tmpEq) === pCookieName)
		{
			return tmpFirst.slice(tmpEq + 1);
		}
	}
	return '';
}

/**
 * Best-effort parse of an `ExpiresAt` field in UV's response body.
 * Returns an absolute ms-epoch timestamp, or 0 when unknown.
 */
function _parseExpires(pBody)
{
	if (!pBody) { return 0; }
	if (pBody.ExpiresAt)
	{
		let tmpMs = Date.parse(pBody.ExpiresAt);
		if (Number.isFinite(tmpMs)) { return tmpMs; }
	}
	return 0;
}

module.exports =
{
	install
};
