'use strict';
/**
 * platform-headers.js
 *
 * Injects Anthropic-Client-OS-Platform and Anthropic-Client-OS-Version headers
 * into outgoing HTTP requests to Anthropic domains.
 *
 * Without these headers, Anthropic's server never enables Cowork or serves the
 * claude-code binary bundle on Linux.  Every working Linux Cowork implementation
 * (johnzfitch, heytcass, patrickjaja, aaddrick) sends these headers.
 *
 * Scope: ONLY requests to *.anthropic.com and *.claude.ai.
 * No other domains are affected.
 *
 * Injected at the top of the main-process bundle by patch-cowork.sh.
 */

const INIT_SYM = Symbol.for('__claudePlatformHeadersInitialised');

if (!global[INIT_SYM]) {
  global[INIT_SYM] = true;

  const PLATFORM_HEADER = 'darwin';
  const VERSION_HEADER  = '14.0';
  const DEBUG = process.env.COWORK_DEBUG === '1';

  const log = (msg) => {
    if (DEBUG) process.stderr.write(`[platform-headers] ${msg}\n`);
  };

  /**
   * Returns true if the hostname belongs to an Anthropic domain that requires
   * platform headers for Cowork activation.
   */
  function isAnthropicHost(hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const h = hostname.toLowerCase();
    return h === 'api.anthropic.com' ||
           h.endsWith('.anthropic.com') ||
           h === 'claude.ai' ||
           h.endsWith('.claude.ai');
  }

  /**
   * Inject platform headers into a headers object (mutates in place).
   * Returns true if headers were injected.
   */
  function injectHeaders(headers, url) {
    if (!headers) return false;
    headers['Anthropic-Client-OS-Platform'] = PLATFORM_HEADER;
    headers['Anthropic-Client-OS-Version']  = VERSION_HEADER;
    log(`Injected platform headers for ${url || 'unknown URL'}`);
    return true;
  }

  /**
   * Extract hostname from a URL string or URL object.
   */
  function getHostname(urlOrString) {
    if (!urlOrString) return null;
    try {
      if (typeof urlOrString === 'string') {
        return new URL(urlOrString).hostname;
      }
      if (urlOrString.hostname) return urlOrString.hostname;
      if (urlOrString.host) return urlOrString.host.split(':')[0];
    } catch (_) {}
    return null;
  }

  // ---------------------------------------------------------------------------
  // Strategy 1: Patch electron.net.request
  // ---------------------------------------------------------------------------
  try {
    const electron = require('electron');
    const net = electron.net;

    if (net && typeof net.request === 'function') {
      const origRequest = net.request.bind(net);

      net.request = function patchedNetRequest(optionsOrUrl, ...rest) {
        let hostname = null;

        if (typeof optionsOrUrl === 'string') {
          hostname = getHostname(optionsOrUrl);
        } else if (optionsOrUrl && typeof optionsOrUrl === 'object') {
          hostname = optionsOrUrl.hostname || optionsOrUrl.host ||
                     getHostname(optionsOrUrl.url);
        }

        const req = origRequest(optionsOrUrl, ...rest);

        if (hostname && isAnthropicHost(hostname)) {
          // Intercept setHeader to ensure our headers survive
          const origEnd = req.end.bind(req);
          const origWrite = req.write ? req.write.bind(req) : null;
          let headersInjected = false;

          const ensureHeaders = () => {
            if (!headersInjected) {
              headersInjected = true;
              try {
                req.setHeader('Anthropic-Client-OS-Platform', PLATFORM_HEADER);
                req.setHeader('Anthropic-Client-OS-Version', VERSION_HEADER);
                log(`net.request: injected headers for ${hostname}`);
              } catch (e) {
                log(`net.request: failed to set headers: ${e.message}`);
              }
            }
          };

          req.end = function patchedEnd(...args) {
            ensureHeaders();
            return origEnd(...args);
          };

          if (origWrite) {
            req.write = function patchedWrite(...args) {
              ensureHeaders();
              return origWrite(...args);
            };
          }
        }

        return req;
      };

      debug('electron.net.request patched');
    }
  } catch (e) {
    process.stderr.write(`[platform-headers] electron.net.request patch failed: ${e.message}\n`);
  }

  // ---------------------------------------------------------------------------
  // Strategy 2: Patch Node.js https.request and http.request
  // ---------------------------------------------------------------------------
  try {
    const https = require('https');
    const http  = require('http');

    for (const mod of [https, http]) {
      if (!mod || typeof mod.request !== 'function') continue;

      const origRequest = mod.request;
      const modName = mod === https ? 'https' : 'http';

      mod.request = function patchedRequest(urlOrOptions, optionsOrCb, cb) {
        let hostname = null;
        let options = urlOrOptions;

        if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
          hostname = getHostname(urlOrOptions);
          if (typeof optionsOrCb === 'object' && optionsOrCb !== null) {
            options = urlOrOptions;
          }
        } else if (urlOrOptions && typeof urlOrOptions === 'object') {
          hostname = urlOrOptions.hostname || urlOrOptions.host;
          if (hostname) hostname = hostname.split(':')[0];
        }

        if (hostname && isAnthropicHost(hostname)) {
          // For object-style options, inject headers directly
          if (typeof urlOrOptions === 'object' && urlOrOptions !== null &&
              !(urlOrOptions instanceof URL)) {
            if (!urlOrOptions.headers) urlOrOptions.headers = {};
            injectHeaders(urlOrOptions.headers, `${modName}://${hostname}`);
          } else if (typeof optionsOrCb === 'object' && optionsOrCb !== null) {
            if (!optionsOrCb.headers) optionsOrCb.headers = {};
            injectHeaders(optionsOrCb.headers, `${modName}://${hostname}`);
          } else {
            // URL-only form: request(urlString, cb) — no options object to
            // mutate.  Inject via setHeader on the returned ClientRequest.
            const req = origRequest.call(mod, urlOrOptions, optionsOrCb, cb);
            try {
              req.setHeader('Anthropic-Client-OS-Platform', PLATFORM_HEADER);
              req.setHeader('Anthropic-Client-OS-Version', VERSION_HEADER);
              log(`${modName}.request: injected headers via setHeader for ${hostname}`);
            } catch (e) {
              log(`${modName}.request: setHeader failed: ${e.message}`);
            }
            return req;
          }
        }

        return origRequest.call(mod, urlOrOptions, optionsOrCb, cb);
      };

      // Also patch mod.get which is a wrapper around mod.request
      if (typeof mod.get === 'function') {
        const origGet = mod.get;
        mod.get = function patchedGet(urlOrOptions, optionsOrCb, cb) {
          let hostname = null;

          if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
            hostname = getHostname(urlOrOptions);
          } else if (urlOrOptions && typeof urlOrOptions === 'object') {
            hostname = urlOrOptions.hostname || urlOrOptions.host;
            if (hostname) hostname = hostname.split(':')[0];
          }

          if (hostname && isAnthropicHost(hostname)) {
            if (typeof urlOrOptions === 'object' && urlOrOptions !== null &&
                !(urlOrOptions instanceof URL)) {
              if (!urlOrOptions.headers) urlOrOptions.headers = {};
              injectHeaders(urlOrOptions.headers, `${modName}://${hostname}`);
            } else if (typeof optionsOrCb === 'object' && optionsOrCb !== null) {
              if (!optionsOrCb.headers) optionsOrCb.headers = {};
              injectHeaders(optionsOrCb.headers, `${modName}://${hostname}`);
            } else {
              // URL-only form: get(urlString, cb) — inject via setHeader.
              const req = origGet.call(mod, urlOrOptions, optionsOrCb, cb);
              try {
                req.setHeader('Anthropic-Client-OS-Platform', PLATFORM_HEADER);
                req.setHeader('Anthropic-Client-OS-Version', VERSION_HEADER);
                log(`${modName}.get: injected headers via setHeader for ${hostname}`);
              } catch (e) {
                log(`${modName}.get: setHeader failed: ${e.message}`);
              }
              return req;
            }
          }

          return origGet.call(mod, urlOrOptions, optionsOrCb, cb);
        };
      }

      debug(`${modName}.request patched`);
    }
  } catch (e) {
    process.stderr.write(`[platform-headers] http/https patch failed: ${e.message}\n`);
  }

  // ---------------------------------------------------------------------------
  // Strategy 3: Patch Electron session webRequest (catches fetch() from renderer)
  // ---------------------------------------------------------------------------
  try {
    const { app, session } = require('electron');

    const installWebRequestPatch = () => {
      const ses = session.defaultSession;
      if (!ses || !ses.webRequest) return;

      ses.webRequest.onBeforeSendHeaders(
        { urls: ['*://*.anthropic.com/*', '*://*.claude.ai/*', '*://claude.ai/*', '*://api.anthropic.com/*'] },
        (details, callback) => {
          details.requestHeaders['Anthropic-Client-OS-Platform'] = PLATFORM_HEADER;
          details.requestHeaders['Anthropic-Client-OS-Version']  = VERSION_HEADER;
          log(`webRequest: injected headers for ${details.url}`);
          callback({ requestHeaders: details.requestHeaders });
        }
      );

      debug('session.webRequest.onBeforeSendHeaders patched');
    };

    if (app.isReady()) {
      installWebRequestPatch();
    } else {
      app.once('ready', installWebRequestPatch);
    }
  } catch (e) {
    process.stderr.write(`[platform-headers] webRequest patch failed: ${e.message}\n`);
  }

  debug('Platform header injection installed');
}
