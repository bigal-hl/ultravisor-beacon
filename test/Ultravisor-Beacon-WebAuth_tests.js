/**
 * Ultravisor-Beacon-WebAuth — integration tests
 *
 * Mounts the WebAuth helper onto an in-memory stub Orator server,
 * stands up a real http stub Ultravisor next to it, and exercises the
 * proxy paths a real beacon would hit at runtime:
 *
 *   - POST /1.0/Authenticate            forwards body + RequestingBeacon
 *                                       to UV; mints a beacon-scoped
 *                                       opaque cookie (NOT UV's value);
 *                                       stores the mapping; returns
 *                                       JSON with the beacon SessionID.
 *   - GET  /1.0/CheckSession            uses the beacon cookie locally;
 *                                       falls through to UV after the
 *                                       cache window.
 *   - POST /1.0/Deauthenticate          forwards UV the mapped session
 *                                       and clears local mapping.
 *   - GET  /status                      proxies UV and decorates with
 *                                       BeaconName / BeaconID.
 *
 * No restify or orator in the dev tree — we build a tiny in-memory
 * service-server stub that captures route handlers, then call them
 * directly with stub req/res objects.  This keeps the test fast and
 * focused on the proxy logic.
 */

const libAssert = require('assert');
const libHTTP = require('http');

const libWebAuth = require('../source/Ultravisor-Beacon-WebAuth.cjs');

// ────────────────────────────────────────────────────────────────────────
// Stub UV server — captures every incoming request so tests can assert
// on body shapes + response with whatever the scenario needs.
// ────────────────────────────────────────────────────────────────────────
function startStubUV(pHandler, fCallback)
{
	let tmpServer = libHTTP.createServer((pReq, pRes) =>
	{
		let tmpBody = '';
		pReq.on('data', (pChunk) => { tmpBody += pChunk; });
		pReq.on('end', () =>
		{
			let tmpParsed = null;
			if (tmpBody)
			{
				try { tmpParsed = JSON.parse(tmpBody); } catch (pErr) { tmpParsed = tmpBody; }
			}
			pHandler(pReq, pRes, tmpParsed);
		});
	});
	tmpServer.listen(0, '127.0.0.1', () =>
	{
		let tmpPort = tmpServer.address().port;
		fCallback(null, tmpServer, tmpPort);
	});
}

// ────────────────────────────────────────────────────────────────────────
// Stub OratorServiceServer — captures route handlers as a Map keyed by
// `${METHOD} ${path}` so the test can dispatch them manually.
// ────────────────────────────────────────────────────────────────────────
function buildStubOrator()
{
	let tmpRoutes = new Map();
	let tmpMiddleware = [];
	let tmpServiceServer =
	{
		get: function (pPath, pHandler) { tmpRoutes.set('GET ' + pPath, pHandler); },
		post: function (pPath, pHandler) { tmpRoutes.set('POST ' + pPath, pHandler); },
		use: function (pHandler) { tmpMiddleware.push(pHandler); }
	};
	return {
		serviceServer: tmpServiceServer,
		_routes: tmpRoutes,
		_middleware: tmpMiddleware
	};
}

function stubRes()
{
	let tmpRes =
	{
		_status: null,
		_body: null,
		_headers: {},
		send: function (pA, pB)
		{
			// Restify-style: send(status?, body)
			if (arguments.length === 1) { this._body = pA; this._status = 200; }
			else { this._status = pA; this._body = pB; }
		},
		header: function (pName, pValue) { this._headers[pName] = pValue; },
		setHeader: function (pName, pValue) { this._headers[pName] = pValue; }
	};
	return tmpRes;
}

function dispatch(pHarness, pMethodPath, pReq)
{
	let tmpHandler = pHarness._routes.get(pMethodPath);
	if (!tmpHandler) { throw new Error('No route registered for ' + pMethodPath); }
	let tmpRes = stubRes();
	return new Promise((fResolve) =>
		{
			tmpHandler(pReq, tmpRes, () => fResolve(tmpRes));
		});
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────
suite
(
	'Ultravisor-Beacon-WebAuth — proxy + indirection',
	function ()
	{
		let _UVServer = null;
		let _UVPort = 0;
		let _LastUVRequest = null;   // { method, url, body, cookie }
		let _UVResponder = null;     // function(pReq, pRes, pBody) — set per test

		setup
		(
			function (fDone)
			{
				_LastUVRequest = null;
				_UVResponder = null;
				startStubUV((pReq, pRes, pBody) =>
					{
						_LastUVRequest =
							{
								method: pReq.method,
								url:    pReq.url,
								body:   pBody,
								cookie: pReq.headers.cookie || ''
							};
						if (_UVResponder) { _UVResponder(pReq, pRes, pBody); }
						else
						{
							pRes.writeHead(500);
							pRes.end(JSON.stringify({ Error: 'no responder configured' }));
						}
					}, (pErr, pServer, pPort) =>
					{
						_UVServer = pServer;
						_UVPort = pPort;
						fDone();
					});
			}
		);

		teardown
		(
			function (fDone)
			{
				if (_UVServer) { _UVServer.close(() => fDone()); }
				else { fDone(); }
			}
		);

		test
		(
			'install requires UltravisorURL + BeaconName',
			function ()
			{
				let tmpHarness = buildStubOrator();
				libAssert.throws(
					() => libWebAuth.install(tmpHarness, {}),
					/UltravisorURL is required/);
				libAssert.throws(
					() => libWebAuth.install(tmpHarness, { UltravisorURL: 'http://x' }),
					/BeaconName is required/);
			}
		);

		test
		(
			'install registers the four expected routes',
			function ()
			{
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{
						UltravisorURL: `http://127.0.0.1:${_UVPort}`,
						BeaconName:    'test-beacon'
					});
				libAssert.ok(tmpHarness._routes.has('POST /1.0/Authenticate'));
				libAssert.ok(tmpHarness._routes.has('GET /1.0/CheckSession'));
				libAssert.ok(tmpHarness._routes.has('POST /1.0/Deauthenticate'));
				libAssert.ok(tmpHarness._routes.has('GET /status'));
			}
		);

		test
		(
			'POST /1.0/Authenticate forwards RequestingBeacon and mints opaque cookie',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						pRes.writeHead(200,
							{
								'Content-Type': 'application/json',
								'Set-Cookie':  'SessionID=uv-session-abc; HttpOnly'
							});
						pRes.end(JSON.stringify(
							{
								LoggedIn:  true,
								SessionID: 'uv-session-abc',
								UserID:    42,
								UserRecord: { LoginID: 'alice', IDUser: 42 }
							}));
					};

				let tmpHarness = buildStubOrator();
				let tmpHandle = libWebAuth.install(tmpHarness,
					{
						UltravisorURL: `http://127.0.0.1:${_UVPort}`,
						BeaconName:    'retold-databeacon',
						BeaconID:      'b-12345'
					});
				let tmpResp = await dispatch(tmpHarness, 'POST /1.0/Authenticate',
					{
						headers: { 'user-agent': 'curl/8.test' },
						body:    { UserName: 'alice', Password: 'pw' }
					});

				libAssert.strictEqual(tmpResp._status, 200);
				libAssert.strictEqual(tmpResp._body.LoggedIn, true);
				// Beacon cookie value MUST differ from UV's SessionID
				let tmpCookieHeader = tmpResp._headers['Set-Cookie'];
				libAssert.ok(tmpCookieHeader);
				let tmpBeaconSession = /SessionID=([^;]+)/.exec(tmpCookieHeader)[1];
				libAssert.notStrictEqual(tmpBeaconSession, 'uv-session-abc');
				libAssert.ok(tmpBeaconSession.length >= 32);
				libAssert.strictEqual(tmpResp._body.SessionID, tmpBeaconSession);
				// Mapping in store
				let tmpStore = tmpHandle.getStore();
				libAssert.ok(tmpStore.has(tmpBeaconSession));
				libAssert.strictEqual(tmpStore.get(tmpBeaconSession).UVSessionID, 'uv-session-abc');
				// RequestingBeacon was forwarded to UV
				libAssert.deepStrictEqual(_LastUVRequest.body.RequestingBeacon,
					{ Name: 'retold-databeacon', BeaconID: 'b-12345', UserAgent: 'curl/8.test' });
				libAssert.strictEqual(_LastUVRequest.body.UserName, 'alice');
				libAssert.strictEqual(_LastUVRequest.body.Password, 'pw');
			}
		);

		test
		(
			'POST /1.0/Authenticate forwards UV failure verbatim',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						pRes.writeHead(401, { 'Content-Type': 'application/json' });
						pRes.end(JSON.stringify({ LoggedIn: false, Error: 'Authentication failed.' }));
					};
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{ UltravisorURL: `http://127.0.0.1:${_UVPort}`, BeaconName: 'b' });
				let tmpResp = await dispatch(tmpHarness, 'POST /1.0/Authenticate',
					{ headers: {}, body: { UserName: 'bob', Password: 'wrong' } });
				libAssert.strictEqual(tmpResp._status, 401);
				libAssert.strictEqual(tmpResp._body.LoggedIn, false);
				libAssert.ok(/^SessionID=/.test(String(tmpResp._headers['Set-Cookie'] || '')) === false);
			}
		);

		test
		(
			'GET /1.0/CheckSession returns cached LoggedIn:true for known cookie',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						pRes.writeHead(200,
							{
								'Set-Cookie': 'SessionID=uv-1; HttpOnly',
								'Content-Type': 'application/json'
							});
						pRes.end(JSON.stringify({ LoggedIn: true, SessionID: 'uv-1', UserRecord: { LoginID: 'alice' } }));
					};
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{ UltravisorURL: `http://127.0.0.1:${_UVPort}`, BeaconName: 'b' });

				let tmpLogin = await dispatch(tmpHarness, 'POST /1.0/Authenticate',
					{ headers: {}, body: { UserName: 'alice', Password: 'pw' } });
				let tmpBeaconSession = /SessionID=([^;]+)/.exec(tmpLogin._headers['Set-Cookie'])[1];

				// CheckSession with the beacon cookie should resolve from
				// the local map without calling UV again (within the cache
				// window).  Reset the UV captor to confirm no roundtrip.
				_LastUVRequest = null;
				let tmpCheck = await dispatch(tmpHarness, 'GET /1.0/CheckSession',
					{ headers: { cookie: `SessionID=${tmpBeaconSession}` } });
				libAssert.strictEqual(tmpCheck._status, 200);
				libAssert.strictEqual(tmpCheck._body.LoggedIn, true);
				libAssert.strictEqual(_LastUVRequest, null, 'CheckSession should not roundtrip to UV inside cache window');
			}
		);

		test
		(
			'GET /1.0/CheckSession returns LoggedIn:false for missing cookie',
			async function ()
			{
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{ UltravisorURL: `http://127.0.0.1:${_UVPort}`, BeaconName: 'b' });
				let tmpCheck = await dispatch(tmpHarness, 'GET /1.0/CheckSession',
					{ headers: {} });
				libAssert.strictEqual(tmpCheck._status, 200);
				libAssert.strictEqual(tmpCheck._body.LoggedIn, false);
			}
		);

		test
		(
			'POST /1.0/Deauthenticate forwards the mapped UV session and clears the local mapping',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						if (pReq.url.indexOf('/Authenticate') >= 0)
						{
							pRes.writeHead(200,
								{
									'Set-Cookie': 'SessionID=uv-7; HttpOnly',
									'Content-Type': 'application/json'
								});
							pRes.end(JSON.stringify({ LoggedIn: true, SessionID: 'uv-7' }));
						}
						else
						{
							pRes.writeHead(200, { 'Content-Type': 'application/json' });
							pRes.end(JSON.stringify({ LoggedIn: false }));
						}
					};
				let tmpHarness = buildStubOrator();
				let tmpHandle = libWebAuth.install(tmpHarness,
					{ UltravisorURL: `http://127.0.0.1:${_UVPort}`, BeaconName: 'b' });

				let tmpLogin = await dispatch(tmpHarness, 'POST /1.0/Authenticate',
					{ headers: {}, body: { UserName: 'a', Password: 'p' } });
				let tmpBs = /SessionID=([^;]+)/.exec(tmpLogin._headers['Set-Cookie'])[1];
				libAssert.ok(tmpHandle.getStore().has(tmpBs));

				let tmpOut = await dispatch(tmpHarness, 'POST /1.0/Deauthenticate',
					{ headers: { cookie: `SessionID=${tmpBs}` } });
				libAssert.strictEqual(tmpOut._status, 200);
				// UV was called with the UV cookie (not the beacon cookie)
				libAssert.ok(_LastUVRequest.url.indexOf('/Deauthenticate') >= 0);
				libAssert.ok(_LastUVRequest.cookie.indexOf('uv-7') >= 0);
				// Local mapping cleared
				libAssert.strictEqual(tmpHandle.getStore().has(tmpBs), false);
				// Cookie was cleared on the response (Max-Age=0 header)
				let tmpClear = tmpOut._headers['Set-Cookie'];
				libAssert.ok(tmpClear);
				libAssert.ok(/Max-Age=0/.test(tmpClear));
			}
		);

		test
		(
			'GET /status proxies UV body and adds BeaconName + BeaconID',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						pRes.writeHead(200, { 'Content-Type': 'application/json' });
						pRes.end(JSON.stringify(
							{
								Status: 'Running',
								AuthMode: 'authenticated',
								AuthEnabled: true,
								SupportsUserManagement: true
							}));
					};
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{
						UltravisorURL: `http://127.0.0.1:${_UVPort}`,
						BeaconName:    'retold-databeacon',
						BeaconID:      'b-xyz'
					});
				let tmpResp = await dispatch(tmpHarness, 'GET /status', { headers: {} });
				libAssert.strictEqual(tmpResp._status, 200);
				libAssert.strictEqual(tmpResp._body.Status, 'Running');
				libAssert.strictEqual(tmpResp._body.AuthMode, 'authenticated');
				libAssert.strictEqual(tmpResp._body.SupportsUserManagement, true);
				libAssert.strictEqual(tmpResp._body.BeaconName, 'retold-databeacon');
				libAssert.strictEqual(tmpResp._body.BeaconID, 'b-xyz');
			}
		);

		test
		(
			'GET /status falls back to AuthMode: unknown when UV is unreachable',
			async function ()
			{
				// Replace the stub with a closed server so requests hang/refuse.
				_UVServer.close();
				_UVServer = null;
				let tmpHarness = buildStubOrator();
				libWebAuth.install(tmpHarness,
					{
						UltravisorURL: `http://127.0.0.1:${_UVPort}`,
						BeaconName:    'b',
						UltravisorTimeoutMs: 300
					});
				let tmpResp = await dispatch(tmpHarness, 'GET /status', { headers: {} });
				libAssert.strictEqual(tmpResp._status, 200);
				libAssert.strictEqual(tmpResp._body.AuthMode, 'unknown');
				libAssert.strictEqual(tmpResp._body.BeaconName, 'b');
			}
		);

		test
		(
			'BeaconID resolver is called lazily (lets the BeaconID be unknown at install time)',
			async function ()
			{
				_UVResponder = (pReq, pRes) =>
					{
						pRes.writeHead(200, { 'Content-Type': 'application/json' });
						pRes.end(JSON.stringify({ Status: 'Running', AuthMode: 'promiscuous' }));
					};
				let tmpHarness = buildStubOrator();
				let tmpResolvedID = '';
				libWebAuth.install(tmpHarness,
					{
						UltravisorURL: `http://127.0.0.1:${_UVPort}`,
						BeaconName:    'lazy',
						BeaconID:      () => tmpResolvedID
					});
				tmpResolvedID = 'b-late';
				let tmpResp = await dispatch(tmpHarness, 'GET /status', { headers: {} });
				libAssert.strictEqual(tmpResp._body.BeaconID, 'b-late');
			}
		);
	}
);
