/* exported getActiveTab onTabReady stringAsRegExp getTabRealURL openURL
  getStyleWithNoCode tryRegExp sessionStorageHash download deepEqual
  closeCurrentTab capitalize CHROME_HAS_BORDER_BUG */
/* global promisify msg */
'use strict';

const CHROME = Boolean(chrome.app) && parseInt(navigator.userAgent.match(/Chrom\w+\/(?:\d+\.){2}(\d+)|$/)[1]);
const OPERA = Boolean(chrome.app) && parseFloat(navigator.userAgent.match(/\bOPR\/(\d+\.\d+)|$/)[1]);
const VIVALDI = Boolean(chrome.app) && navigator.userAgent.includes('Vivaldi');
// FIXME: who use this?
// const ANDROID = !chrome.windows;
let FIREFOX = !chrome.app && parseFloat(navigator.userAgent.match(/\bFirefox\/(\d+\.\d+)|$/)[1]);

// see PR #781
const CHROME_HAS_BORDER_BUG = CHROME >= 3167 && CHROME <= 3704;

if (!CHROME && !chrome.browserAction.openPopup) {
  // in FF pre-57 legacy addons can override useragent so we assume the worst
  // until we know for sure in the async getBrowserInfo()
  // (browserAction.openPopup was added in 57)
  FIREFOX = browser.runtime.getBrowserInfo ? 51 : 50;
  // getBrowserInfo was added in FF 51
  Promise.resolve(FIREFOX >= 51 ? browser.runtime.getBrowserInfo() : {version: 50}).then(info => {
    FIREFOX = parseFloat(info.version);
    document.documentElement.classList.add('moz-appearance-bug', FIREFOX && FIREFOX < 54);
  });
}

const URLS = {
  ownOrigin: chrome.runtime.getURL(''),

  // FIXME delete?
  optionsUI: [
    chrome.runtime.getURL('options.html'),
    'chrome://extensions/?options=' + chrome.runtime.id,
  ],

  configureCommands:
    OPERA ? 'opera://settings/configureCommands'
          : 'chrome://extensions/configureCommands',

  // CWS cannot be scripted in chromium, see ChromeExtensionsClient::IsScriptableURL
  // https://cs.chromium.org/chromium/src/chrome/common/extensions/chrome_extensions_client.cc
  browserWebStore:
    FIREFOX ? 'https://addons.mozilla.org/' :
    OPERA ? 'https://addons.opera.com/' :
      'https://chrome.google.com/webstore/',

  emptyTab: [
    // Chrome and simple forks
    'chrome://newtab/',
    // Opera
    'chrome://startpage/',
    // Vivaldi
    'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/startpage/startpage.html',
    // Firefox
    'about:home',
    'about:newtab',
  ],

  // Chrome 61.0.3161+ doesn't run content scripts on NTP https://crrev.com/2978953002/
  // TODO: remove when "minimum_chrome_version": "61" or higher
  chromeProtectsNTP: CHROME >= 3161,

  userstylesOrgJson: 'https://userstyles.org/styles/chrome/',

  supported: url => (
    url.startsWith('http') && (FIREFOX || !url.startsWith(URLS.browserWebStore)) ||
    url.startsWith('ftp') ||
    url.startsWith('file') ||
    url.startsWith(URLS.ownOrigin) ||
    !URLS.chromeProtectsNTP && url.startsWith('chrome://newtab/')
  ),
};

const IS_BG = chrome.extension.getBackgroundPage && chrome.extension.getBackgroundPage() === window;

if (!IS_BG) {
  if (FIREFOX) {
    document.documentElement.classList.add('firefox');
  } else if (OPERA) {
    document.documentElement.classList.add('opera');
  } else {
    if (VIVALDI) document.documentElement.classList.add('vivaldi');
  }
}

if (IS_BG) {
  window.API_METHODS = {};
}

// FIXME: `localStorage` and `sessionStorage` may be disabled via dom.storage.enabled
// Object.defineProperty(window, 'localStorage', {value: {}});
// Object.defineProperty(window, 'sessionStorage', {value: {}});

const createTab = promisify(chrome.tabs.create.bind(chrome.tabs));
const queryTabs = promisify(chrome.tabs.query.bind(chrome.tabs));
const updateTab = promisify(chrome.tabs.update.bind(chrome.tabs));
const moveTabs = promisify(chrome.tabs.move.bind(chrome.tabs));
// FIXME: is it possible that chrome.windows is undefined?
const updateWindow = promisify(chrome.windows.update.bind(chrome.windows));
const createWindow = promisify(chrome.windows.create.bind(chrome.windows));

function getTab(id) {
  return new Promise(resolve =>
    chrome.tabs.get(id, tab =>
      !chrome.runtime.lastError && resolve(tab)));
}


function getOwnTab() {
  return new Promise(resolve =>
    chrome.tabs.getCurrent(tab => resolve(tab)));
}


function getActiveTab() {
  return queryTabs({currentWindow: true, active: true})
    .then(tabs => tabs[0]);
}

function getTabRealURL(tab) {
  return new Promise(resolve => {
    if (tab.url !== 'chrome://newtab/' || URLS.chromeProtectsNTP) {
      resolve(tab.url);
    } else {
      chrome.webNavigation.getFrame({tabId: tab.id, frameId: 0, processId: -1}, frame => {
        resolve(frame && frame.url || '');
      });
    }
  });
}

/**
 * Resolves when the [just created] tab is ready for communication.
 * @param {Number|Tab} tabOrId
 * @returns {Promise<?Tab>}
 */
function onTabReady(tabOrId) {
  let tabId, tab;
  if (Number.isInteger(tabOrId)) {
    tabId = tabOrId;
  } else {
    tab = tabOrId;
    tabId = tab && tab.id;
  }
  if (!tab) {
    return getTab(tabId).then(onTabReady);
  }
  if (tab.status === 'complete') {
    if (!FIREFOX || tab.url !== 'about:blank') {
      return Promise.resolve(tab);
    } else {
      return new Promise(resolve => {
        chrome.webNavigation.getFrame({tabId, frameId: 0}, frame => {
          ignoreChromeError();
          if (frame) {
            onTabReady(tab).then(resolve);
          } else {
            setTimeout(() => onTabReady(tabId).then(resolve));
          }
        });
      });
    }
  }
  return new Promise((resolve, reject) => {
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.tabs.onReplaced.addListener(onTabReplaced);
    function onCommitted(info) {
      if (info.tabId !== tabId) return;
      unregister();
      getTab(tab.id).then(resolve);
    }
    function onErrorOccurred(info) {
      if (info.tabId !== tabId) return;
      unregister();
      reject();
    }
    function onTabRemoved(removedTabId) {
      if (removedTabId !== tabId) return;
      unregister();
      reject();
    }
    function onTabReplaced(addedTabId, removedTabId) {
      onTabRemoved(removedTabId);
    }
    function unregister() {
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
      chrome.tabs.onReplaced.removeListener(onTabReplaced);
    }
  });
}

function urlToMatchPattern(url) {
  // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns
  if (!/^(http|https|ws|wss|ftp|data|file)$/.test(url.protocol)) {
    return undefined;
  }
  // FIXME: is %2f allowed in pathname and search?
  return `${url.protocol}//${url.hostname}/${url.pathname}${url.search}`;
}

function findExistTab(url, currentWindow) {
  url = new URL(url);
  const normalizedUrl = url.href.split('#')[0];
  return queryTabs({url: urlToMatchPattern(url), currentWindow})
    // FIXME: is tab.url always normalized?
    .then(tabs => tabs.find(tab => tab.url.split('#')[0] === normalizedUrl));
}

/**
 * Opens a tab or activates an existing one,
 * reuses the New Tab page or about:blank if it's focused now
 * @param {Object} params
 *        or just a string e.g. openURL('foo')
 * @param {string} params.url
 *        if relative, it's auto-expanded to the full extension URL
 * @param {number} [params.index]
 *        move the tab to this index in the tab strip, -1 = last
 * @param {Boolean} [params.active]
 *        true to activate the tab (this is the default value in the extensions API),
 *        false to open in background
 * @param {?Boolean} [params.currentWindow]
 *        pass null to check all windows
 * @param {any} [params.message]
 *        JSONifiable data to be sent to the tab via sendMessage()
 * @returns {Promise<Tab>} Promise that resolves to the opened/activated tab
 */
function openURL(options) {
  if (typeof options === 'string') {
    options = {url: options};
  }
  let {
    url,
    index,
    active,
    currentWindow = true,
    newWindow = false,
    windowPosition
  } = options;

  if (!url.includes('://')) {
    url = chrome.runtime.getURL(url);
  }
  return findExistTab(url, currentWindow)
    .then(tab => {
      if (!tab) {
        return getActiveTab().then(maybeReplace);
      }
      // update url if only hash is different?
      if (tab.url !== url && tab.url.split('#')[0] === url.split('#')[0]) {
        if (url.includes('#')) {
          return activateTab(tab, {url, index});
        } else {
          // we can't update URL directly since it refresh the page
          return Promise.all([
            activateTab(tab, {index}),
            msg.sendTab(tab.id, {method: 'trimHash'}).catch(console.warn)
          ]);
        }
      }
      return activateTab(tab, {index});
    });

  // update current NTP or about:blank
  // except when 'url' is chrome:// or chrome-extension:// in incognito
  function maybeReplace(tab) {
    const chromeInIncognito = tab && tab.incognito && url.startsWith('chrome');
    const emptyTab = tab && URLS.emptyTab.includes(tab.url);
    if (emptyTab && !chromeInIncognito) {
      return activateTab(tab, {url, index}); // FIXME: should we move current empty tab?
    }
    if (newWindow) {
      return createWindow(Object.assign({url}, windowPosition));
    }
    const options = {url, index, active};
    // FF57+ supports openerTabId, but not in Android (indicated by the absence of chrome.windows)
    // FIXME: is it safe to assume that the current tab is the opener?
    if (tab && (!FIREFOX || FIREFOX >= 57 && chrome.windows) && !chromeInIncognito) {
      options.openerTabId = tab.id;
    }
    return createTab(options);
  }
}


function activateTab(tab, {url, index}) {
  const options = {active: true};
  if (url) {
    options.url = url;
  }
  return Promise.all([
    updateTab(tab.id, options),
    updateWindow(tab.windowId, {focused: true}),
    index != null && moveTabs(tab.id, {index})
  ]);
}


function stringAsRegExp(s, flags) {
  return new RegExp(s.replace(/[{}()[\]\\.+*?^$|]/g, '\\$&'), flags);
}


function ignoreChromeError() {
  // eslint-disable-next-line no-unused-expressions
  chrome.runtime.lastError;
}


function getStyleWithNoCode(style) {
  const stripped = deepCopy(style);
  for (const section of stripped.sections) section.code = null;
  stripped.sourceCode = null;
  return stripped;
}


// js engine can't optimize the entire function if it contains try-catch
// so we should keep it isolated from normal code in a minimal wrapper
// Update: might get fixed in V8 TurboFan in the future
function tryCatch(func, ...args) {
  try {
    return func(...args);
  } catch (e) {}
}


function tryRegExp(regexp, flags) {
  try {
    return new RegExp(regexp, flags);
  } catch (e) {}
}


function tryJSONparse(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {}
}


const debounce = Object.assign((fn, delay, ...args) => {
  clearTimeout(debounce.timers.get(fn));
  debounce.timers.set(fn, setTimeout(debounce.run, delay, fn, ...args));
}, {
  timers: new Map(),
  run(fn, ...args) {
    debounce.timers.delete(fn);
    fn(...args);
  },
  unregister(fn) {
    clearTimeout(debounce.timers.get(fn));
    debounce.timers.delete(fn);
  },
});


function deepCopy(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  // N.B. the copy should be an explicit literal
  if (Array.isArray(obj)) {
    const copy = [];
    for (const v of obj) {
      copy.push(!v || typeof v !== 'object' ? v : deepCopy(v));
    }
    return copy;
  }
  const copy = {};
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  for (const k in obj) {
    if (!hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    copy[k] = !v || typeof v !== 'object' ? v : deepCopy(v);
  }
  return copy;
}


function deepEqual(a, b, ignoredKeys) {
  if (!a || !b) return a === b;
  const type = typeof a;
  if (type !== typeof b) return false;
  if (type !== 'object') return a === b;
  if (Array.isArray(a)) {
    return Array.isArray(b) &&
           a.length === b.length &&
           a.every((v, i) => deepEqual(v, b[i], ignoredKeys));
  }
  for (const key in a) {
    if (!Object.hasOwnProperty.call(a, key) ||
        ignoredKeys && ignoredKeys.includes(key)) continue;
    if (!Object.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], ignoredKeys)) return false;
  }
  for (const key in b) {
    if (!Object.hasOwnProperty.call(b, key) ||
        ignoredKeys && ignoredKeys.includes(key)) continue;
    if (!Object.hasOwnProperty.call(a, key)) return false;
  }
  return true;
}


function sessionStorageHash(name) {
  return {
    name,
    value: tryCatch(JSON.parse, sessionStorage[name]) || {},
    set(k, v) {
      this.value[k] = v;
      this.updateStorage();
    },
    unset(k) {
      delete this.value[k];
      this.updateStorage();
    },
    updateStorage() {
      sessionStorage[this.name] = JSON.stringify(this.value);
    }
  };
}

/**
 * @param {String} url
 * @param {Object} params
 * @param {String} [params.method]
 * @param {String|Object} [params.body]
 * @param {String} [params.responseType] arraybuffer, blob, document, json, text
 * @param {Number} [params.requiredStatusCode] resolved when matches, otherwise rejected
 * @param {Number} [params.timeout] ms
 * @param {Object} [params.headers] {name: value}
 * @returns {Promise}
 */
function download(url, {
  method = 'GET',
  body,
  responseType = 'text',
  requiredStatusCode = 200,
  timeout = 10e3,
  headers = {
    'Content-type': 'application/x-www-form-urlencoded',
  },
} = {}) {
  const queryPos = url.indexOf('?');
  if (queryPos > 0 && body === undefined) {
    method = 'POST';
    body = url.slice(queryPos);
    url = url.slice(0, queryPos);
  }
  // * USO can't handle POST requests for style json
  // * XHR/fetch can't handle long URL
  // So we need to collapse all long variables and expand them in the response
  const usoVars = [];

  return new Promise((resolve, reject) => {
    const u = new URL(collapseUsoVars(url));
    if (u.protocol === 'file:' && FIREFOX) {
      // https://stackoverflow.com/questions/42108782/firefox-webextensions-get-local-files-content-by-path
      // FIXME: add FetchController when it is available.
      const timer = setTimeout(reject, timeout, new Error('Timeout fetching ' + u.href));
      fetch(u.href, {mode: 'same-origin'})
        .then(r => {
          clearTimeout(timer);
          return r.status === 200 ? r.text() : Promise.reject(r.status);
        })
        .catch(reject)
        .then(resolve);
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.timeout = timeout;
    xhr.onloadend = event => {
      if (event.type !== 'error' && (
          xhr.status === requiredStatusCode || !requiredStatusCode ||
          u.protocol === 'file:')) {
        resolve(expandUsoVars(xhr.response));
      } else {
        reject(xhr.status);
      }
    };
    xhr.onerror = xhr.onloadend;
    xhr.responseType = responseType;
    xhr.open(method, u.href, true);
    for (const key in headers) {
      xhr.setRequestHeader(key, headers[key]);
    }
    xhr.send(body);
  });

  function collapseUsoVars(url) {
    if (queryPos < 0 ||
        url.length < 2000 ||
        !url.startsWith(URLS.userstylesOrgJson) ||
        !/^get$/i.test(method)) {
      return url;
    }
    const params = new URLSearchParams(url.slice(queryPos + 1));
    for (const [k, v] of params.entries()) {
      if (v.length < 10 || v.startsWith('ik-')) continue;
      usoVars.push(v);
      params.set(k, `\x01${usoVars.length}\x02`);
    }
    return url.slice(0, queryPos + 1) + params.toString();
  }

  function expandUsoVars(response) {
    if (!usoVars.length || !response) return response;
    const isText = typeof response === 'string';
    const json = isText && tryJSONparse(response) || response;
    json.updateUrl = url;
    for (const section of json.sections || []) {
      const {code} = section;
      if (code.includes('\x01')) {
        section.code = code.replace(/\x01(\d+)\x02/g, (_, num) => usoVars[num - 1] || '');
      }
    }
    return isText ? JSON.stringify(json) : json;
  }
}

function closeCurrentTab() {
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1409375
  getOwnTab().then(tab => {
    if (tab) {
      chrome.tabs.remove(tab.id);
    }
  });
}

function capitalize(s) {
  return s[0].toUpperCase() + s.slice(1);
}
