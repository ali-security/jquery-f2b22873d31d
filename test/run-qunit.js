#!/usr/bin/env node
/*
 * Headless QUnit runner for the jQuery browser test suite (CI only).
 *
 * Usage:
 *   node test/run-qunit.js [url]
 *   url defaults to http://127.0.0.1:8000/test/index.html
 *   (serve the repo root, e.g. `php -S 127.0.0.1:8000 -t .`, so that
 *   test/data/*.php endpoints and dist/jquery*.js are reachable).
 *
 * Requirements:
 *   - Node >= 18 (this file is NOT part of the Node 0.10 project toolchain;
 *     it is listed in .jshintignore and test/ is excluded by .npmignore).
 *   - puppeteer (or puppeteer-core, see QUNIT_PUPPETEER_MODULE), resolved in this order:
 *       1. $QUNIT_RUNNER_PREFIX/node_modules/<module>, if QUNIT_RUNNER_PREFIX
 *          is set (e.g. after `npm install --prefix "$HOME/qunit-runner" puppeteer-core@21`),
 *       2. a plain require( "<module>" ) (works with NODE_PATH or a local install).
 *
 * Environment:
 *   QUNIT_RUNNER_PREFIX  install prefix that contains node_modules/<module>
 *   QUNIT_PUPPETEER_MODULE  "puppeteer" (default) or "puppeteer-core"
 *   CHROME_PATH          browser executable to launch (required with puppeteer-core)
 *   QUNIT_TIMEOUT_MS     overall timeout in ms (default 900000 = 15 minutes)
 *
 * How results are collected:
 *   Before any page script runs, page.evaluateOnNewDocument installs an
 *   accessor for window.QUnit in the top-level frame. qunit.js ends with
 *   `window.QUnit = QUnit`, which hits the setter; the setter immediately
 *   registers QUnit.log / QUnit.testDone / QUnit.done callbacks (QUnit 1.x
 *   only starts running tests after window load / QUnit.start(), so this is
 *   always early enough). Callbacks forward serialisable data to Node via
 *   page.exposeFunction.
 *
 * Exit status: 0 only if the suite completed, at least one test ran, and no
 * test failed. 1 otherwise (failures, zero tests, timeout, browser error).
 */
"use strict";

var path = require( "path" );

function loadPuppeteer() {
	var prefix = process.env.QUNIT_RUNNER_PREFIX,
		name = process.env.QUNIT_PUPPETEER_MODULE || "puppeteer";
	if ( prefix ) {
		return require( path.resolve( prefix, "node_modules", name ) );
	}
	return require( name );
}

var url = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html";
var timeoutMs = parseInt( process.env.QUNIT_TIMEOUT_MS || "", 10 ) || 15 * 60 * 1000;
var LAUNCH_TIMEOUT_MS = 60000;
var GOTO_TIMEOUT_MS = 60000;
var HEARTBEAT_MS = 30000;
var startedAt = Date.now();
var stage = "starting";

function elapsed() {
	return Math.round( ( Date.now() - startedAt ) / 1000 ) + "s";
}

function logStage( name, detail ) {
	stage = name;
	console.log( "[runner " + elapsed() + "] " + name + ( detail ? " - " + detail : "" ) );
}

// Rejects with a clear message if `promise` does not settle within `ms`.
// Backstop for puppeteer's own `timeout` options.
function withTimeout( promise, ms, what ) {
	var t;
	var guard = new Promise( function( resolve, reject ) {
		t = setTimeout( function() {
			reject( new Error( what + " did not complete within " + ms + "ms" ) );
		}, ms );
	} );
	return Promise.race( [ promise, guard ] ).finally( function() {
		clearTimeout( t );
	} );
}

// Runs in the page (top frame only), before any page script.
function installHook() {
	if ( window !== window.top ) {
		return;
	}

	function dump( value ) {
		try {
			if ( window.QUnit && window.QUnit.jsDump ) {
				return String( window.QUnit.jsDump.parse( value ) );
			}
		} catch ( e ) {}
		try {
			return JSON.stringify( value );
		} catch ( e ) {
			return String( value );
		}
	}

	function register( Q ) {
		if ( !Q || Q.__ciRunnerHooked || typeof Q.log !== "function" ) {
			return;
		}
		Q.__ciRunnerHooked = true;
		if ( typeof window.__qunitHooked === "function" ) {
			window.__qunitHooked( { version: String( Q.version || "unknown" ) } );
		}

		Q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			window.__qunitLog( {
				module: String( d.module || "" ),
				name: String( d.name || "" ),
				message: d.message == null ? "" : String( d.message ),
				hasExpected: "expected" in d && d.expected !== undefined,
				expected: dump( d.expected ),
				actual: dump( d.actual ),
				source: d.source ? String( d.source ) : ""
			} );
		} );
		Q.testDone( function( d ) {
			window.__qunitTestDone( {
				module: String( d.module || "" ),
				name: String( d.name || "" ),
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
		Q.done( function( d ) {
			window.__qunitDone( {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	var stored;
	try {
		Object.defineProperty( window, "QUnit", {
			configurable: true,
			enumerable: true,
			get: function() {
				return stored;
			},
			set: function( v ) {
				stored = v;
				register( v );
			}
		} );
	} catch ( e ) {}

	// Belt and braces: poll in case the accessor was bypassed.
	var poll = setInterval( function() {
		if ( stored || window.QUnit ) {
			register( stored || window.QUnit );
		}
		if ( ( stored || window.QUnit || {} ).__ciRunnerHooked ) {
			clearInterval( poll );
		}
	}, 5 );
}

async function main() {
	logStage( "loading puppeteer", process.env.QUNIT_RUNNER_PREFIX ?
		"prefix " + process.env.QUNIT_RUNNER_PREFIX : "default resolution" );
	var puppeteer = loadPuppeteer();
	var failuresByTest = new Map();
	var tests = { passed: 0, failed: 0 };
	var finished = false;
	var awaitingDone = false;
	var hooked = false;
	var browser = null;
	var resolveDone;
	var donePromise = new Promise( function( resolve ) {
		resolveDone = resolve;
	} );

	// Overall timeout. Armed before launch so a hang at any stage is bounded.
	var timer = setTimeout( function() {
		if ( !finished ) {
			console.log( "ERROR: QUnit suite did not complete within " + timeoutMs +
				"ms (stage: " + stage + ")" );
			resolveDone( null );
			if ( !awaitingDone ) {
				// Stuck before the suite started (launch/goto); nothing will
				// consume donePromise, so exit here.
				process.exit( 1 );
			}
		}
	}, timeoutMs );

	// Watchdog: heartbeat so CI never goes silent and a stall is visible.
	var heartbeat = setInterval( function() {
		console.log( "[runner " + elapsed() + "] heartbeat - stage: " + stage + ", tests passed: " +
			tests.passed + ", tests failed: " + tests.failed + ", total so far: " +
			( tests.passed + tests.failed ) );
	}, HEARTBEAT_MS );

	try {
		var executablePath = process.env.CHROME_PATH ||
			( typeof puppeteer.executablePath === "function" ?
				puppeteer.executablePath() : "(unknown)" );
		logStage( "launching browser", executablePath + ", timeout " + LAUNCH_TIMEOUT_MS + "ms" );
		try {
			browser = await withTimeout( puppeteer.launch( {
				headless: "new",
				executablePath: process.env.CHROME_PATH || undefined,
				timeout: LAUNCH_TIMEOUT_MS,
				args: [ "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage" ]
			} ), LAUNCH_TIMEOUT_MS + 5000, "puppeteer.launch" );
		} catch ( e ) {
			console.log( "ERROR: failed to launch browser (" + executablePath + "): " +
				( e && e.message ? e.message : e ) );
			return 1;
		}
		logStage( "browser launched", "version " + ( await browser.version() ) );

		var page = await browser.newPage();

		// A headless window is never OS-focused, so focus/blur events would not
		// fire for .focus() calls; emulate a focused page as a real browser has.
		await page.bringToFront();
		var cdp = await page.target().createCDPSession();
		await cdp.send( "Emulation.setFocusEmulationEnabled", { enabled: true } );

		page.on( "console", function( msg ) {
			var type = msg.type();
			if ( type === "error" || type === "warning" || type === "warn" ) {
				console.log( "[browser " + type + "] " + msg.text() );
			}
		} );
		page.on( "pageerror", function( err ) {
			console.log( "[page error] " + ( err && err.message ? err.message : err ) );
		} );
		page.on( "requestfailed", function( req ) {
			var failure = req.failure();
			// Aborted requests are expected (ajax abort tests); skip the noise.
			if ( failure && /ERR_ABORTED/.test( failure.errorText ) ) {
				return;
			}
			console.log( "[request failed] " + req.url() + " " + ( failure ? failure.errorText : "" ) );
		} );

		await page.exposeFunction( "__qunitLog", function( d ) {
			var key = d.module + "\u0000" + d.name;
			if ( !failuresByTest.has( key ) ) {
				failuresByTest.set( key, [] );
			}
			failuresByTest.get( key ).push( d );
		} );
		await page.exposeFunction( "__qunitTestDone", function( d ) {
			var key = d.module + "\u0000" + d.name;
			var ok = d.failed === 0;
			if ( ok ) {
				tests.passed++;
			} else {
				tests.failed++;
			}
			console.log( ( ok ? "PASS " : "FAIL " ) + d.module + " :: " + d.name +
				" (" + d.passed + "/" + d.total + " assertions)" );
			if ( !ok ) {
				( failuresByTest.get( key ) || [] ).forEach( function( f ) {
					console.log( "    - message:  " + f.message );
					if ( f.hasExpected ) {
						console.log( "      expected: " + f.expected );
					}
					console.log( "      actual:   " + f.actual );
					if ( f.source ) {
						console.log( "      source:   " + f.source.split( "\n" ).join( "\n                " ) );
					}
				} );
			}
			failuresByTest.delete( key );
		} );
		await page.exposeFunction( "__qunitDone", function( d ) {
			if ( !finished ) {
				finished = true;
				logStage( "QUnit done" );
				resolveDone( d );
			}
		} );
		await page.exposeFunction( "__qunitHooked", function( d ) {
			hooked = true;
			logStage( "QUnit hooked", "QUnit " + d.version + "; running tests" );
		} );

		await page.evaluateOnNewDocument( installHook );

		logStage( "navigating", url + ", waitUntil load, timeout " + GOTO_TIMEOUT_MS + "ms" );
		var response;
		try {
			response = await withTimeout(
				page.goto( url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS } ),
				GOTO_TIMEOUT_MS + 5000, "page.goto"
			);
		} catch ( e ) {
			console.log( "ERROR: failed to load " + url + ": " + ( e && e.message ? e.message : e ) );
			return 1;
		}
		if ( !response || !response.ok() ) {
			console.log( "ERROR: failed to load " + url + " (HTTP " +
				( response ? response.status() : "no response" ) + ")" );
			return 1;
		}
		logStage( "page loaded", "HTTP " + response.status() );
		if ( !hooked && !finished ) {
			console.log( "[runner " + elapsed() + "] WARNING: QUnit not hooked yet after load" );
		}

		logStage( "waiting for QUnit results" );
		awaitingDone = true;
		var summary = await donePromise;
		if ( !summary ) {
			console.log( "QUnit summary: " + tests.passed + " tests passed, " + tests.failed +
				" tests failed, " + ( tests.passed + tests.failed ) + " total (INCOMPLETE - timed out)" );
			return 1;
		}

		var total = tests.passed + tests.failed;
		console.log( "QUnit summary: " + tests.passed + " tests passed, " + tests.failed +
			" tests failed, " + total + " total; assertions " + summary.passed + " passed / " +
			summary.failed + " failed / " + summary.total + " total; runtime " +
			summary.runtime + "ms" );

		if ( total === 0 ) {
			console.log( "ERROR: no tests ran" );
			return 1;
		}
		return tests.failed > 0 || summary.failed > 0 ? 1 : 0;
	} finally {
		clearTimeout( timer );
		clearInterval( heartbeat );
		if ( browser ) {
			await browser.close().catch( function() {} );
		}
	}
}

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.log( "ERROR: " + ( err && err.stack ? err.stack : err ) );
	process.exit( 1 );
} );
