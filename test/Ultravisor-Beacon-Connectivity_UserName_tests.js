/**
 * Regression test for the UserName-passthrough bug fixed in 1.0.4.
 *
 * Bug history: 1.0.3 added UserName to the BeaconClient layer (for
 * _authenticate's /1.0/Authenticate POST). Both Connectivity transport
 * classes (HTTP + WebSocket) silently dropped UserName when building
 * the config they hand to the Service / BeaconClient. So even though
 * callers were correctly threading UserName through their own options,
 * it never reached the auth call — BeaconClient fell back to Name and
 * tried to login as the mesh handle (e.g. "data-mapper",
 * "private_data_lake_beacon"), which UV's auth-beacon rejected
 * because no user account by that name existed.
 *
 * Fix in 1.0.4: ConnectivityHTTP + ConnectivityWebSocket now accept
 * UserName in their Options and emit it from getTransportConfig().
 *
 * This test locks the transport-config shape so the field can't be
 * dropped again.
 */

const Assert = require('node:assert/strict');
const libConnectivityHTTP = require('../source/Ultravisor-Beacon-ConnectivityHTTP.cjs');
const libConnectivityWebSocket = require('../source/Ultravisor-Beacon-ConnectivityWebSocket.cjs');

suite('Connectivity transport UserName passthrough', function ()
{
	suite('HTTP', function ()
	{
		test('forwards UserName from constructor options into getTransportConfig', function ()
		{
			let tmpConn = new libConnectivityHTTP({
				ServerURL: 'http://uv:54321',
				UserName: 'steven@velozo.com',
				Password: 'secret'
			});
			let tmpCfg = tmpConn.getTransportConfig();
			Assert.equal(tmpCfg.UserName, 'steven@velozo.com');
			Assert.equal(tmpCfg.Password, 'secret');
		});

		test('defaults UserName to empty string when not supplied', function ()
		{
			let tmpConn = new libConnectivityHTTP({ ServerURL: 'http://uv:54321' });
			let tmpCfg = tmpConn.getTransportConfig();
			Assert.equal(tmpCfg.UserName, '');
		});
	});

	suite('WebSocket', function ()
	{
		test('forwards UserName from constructor options into getTransportConfig', function ()
		{
			let tmpConn = new libConnectivityWebSocket({
				ServerURL: 'http://uv:54321',
				UserName: 'steven@velozo.com',
				Password: 'secret'
			});
			let tmpCfg = tmpConn.getTransportConfig();
			Assert.equal(tmpCfg.UserName, 'steven@velozo.com');
			Assert.equal(tmpCfg.Password, 'secret');
			Assert.equal(tmpCfg.Transport, 'WebSocket');
		});

		test('defaults UserName to empty string when not supplied', function ()
		{
			let tmpConn = new libConnectivityWebSocket({ ServerURL: 'http://uv:54321' });
			let tmpCfg = tmpConn.getTransportConfig();
			Assert.equal(tmpCfg.UserName, '');
		});
	});
});
