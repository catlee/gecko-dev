/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

function CMManager() {}

CMManager.prototype = {

  classID: Components.ID("{e1d56432-2d24-4a72-870b-8e98027866f3}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                         Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference]),

  /* ---------- private memebers ---------- */

  // Preferences service
  _prefBranch: null,

  _isSendingHttpRequest: false,

  _locale: null,

  // Randomly generated unique ID for tracking.
  _trackingId: null,

  // Tracking server URL got from the preference extensions.cmmanager.serverurl
  _serverUrl: "http://m.g-fox.cn/cmonline.gif?",

  // Tracking channel ID got from the preference extensions.cmmanager.channelid
  _channelId: "firefox.mobile",

  // To show the log with logcat, set _debug to true and run the following
  // commands:
  // adb shell stop
  // adb shell setprop log.redirect-stdio true
  // adb shell start
  _debug: true,

  /*
   * Setup
   *
   * Initialize the CMManager.
   *
   */
  setup: function() {
    if (this._debug) {
      this.log("Setup\n");
    }

    this._locale = Cc["@mozilla.org/chrome/chrome-registry;1"]
      .getService(Ci.nsIXULChromeRegistry).getSelectedLocale("global");

    try {
      this._prefBranch = Services.prefs.getBranch("extensions.cmmanager.");
      // Get the tracking server URL
      //this._serverUrl = this._prefBranch.getCharPref("serverurl");
      this._channelId = this._prefBranch.getCharPref("channelid");
    } catch(e) {
      this.log(e);
    }

    // Get the tracking ID and create it if not exists,
    try {
      this._trackingId = this._prefBranch.getCharPref("cmmanagerId");
    } catch (e) {
      this._trackingId = Date.now().toString() + Math.random().toString();
      this._prefBranch.setCharPref("cmmanagerId", this._trackingId);
    }

    // Get the activetime and set it to 0 if not exists.
    try {
      this._prefBranch.getIntPref("activetime");
    } catch (e) {
      this._prefBranch.setIntPref("activetime", 0);
    }

    // Register the quit notification to tear down the component before
    // quiting.
    Services.obs.addObserver(this, "quit-application-granted", false);

    // WebProgressListener for getting notification of url loads.
    let progress = Cc["@mozilla.org/docloaderservice;1"].getService(
      Ci.nsIWebProgress);
    progress.addProgressListener(this, Ci.nsIWebProgress.NOTIFY_LOCATION);

    this.sendTrackingHttpRequest("start");
  },

  /*
   * Tear down
   * Uninitialize the CMManager
   */
  tearDown: function() {
    if (this._debug) {
      this.log("Tear down\n");
    }

    let progress = Cc["@mozilla.org/docloaderservice;1"].getService(
      Ci.nsIWebProgress);
    progress.removeProgressListener(this);

    Services.obs.removeObserver(this, "quit-application-granted");

    this.sendTrackingHttpRequest("close");

    this._prefBranch = null;
  },

  /*
   * log
   *
   * Internal function for logging debug messages to the Error Console window
   */
  log: function(message) {
    dump("CMManager: " + message + "\n");
    Services.console.logStringMessage("CMManager: " + message);
  },

  /*
   * Send Tracking HTTP request using GET method
   * @param {string} type The tracking type, including "start", "close",
   * "activate", and "live".
   *
   */
  sendTrackingHttpRequest: function(type) {
    let self = this;

    if (this._isSendingHttpRequest) {
      return;
    }

    this._isSendingHttpRequest = true;

    let req = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].
      createInstance(Ci.nsIXMLHttpRequest);
    let url = StringUtils.format(
                  "{0}key={1}&channelid={2}&type={3}&version={4}&locale={5}&t={6}",
                  this._serverUrl,
                  this._trackingId,
                  this._channelId,
                  type,
                  Services.appinfo.version,
                  this._locale,
                  Date.now().toString()
                  );
    req.open("GET", url, true);
    if (this._debug) {
      this.log('sendTrackingHttpRequest: ' + url);
    }

    req.addEventListener("error", function onError() {
      self._isSendingHttpRequest = false;
    }, false);

    req.addEventListener("load", function onSuccess() {
      // Check _prefBranch as it will be null when we quit the application.
      if ((type == "activate" || type == "live") && self._prefBranch) {
        // Save the activating time
        let startday = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
        self._prefBranch.setIntPref("activetime", startday);
      }
      self._isSendingHttpRequest = false;
    }, false);

    req.send(null);
  },

  /* ---------- nsObserver  ---------- */

  observe: function(subject, topic, data) {
    switch (topic) {
    case "profile-after-change":
      this.setup();
      break;
    case "quit-application-granted":
      this.tearDown();
      break;
    default:
      if (this._debug) {
        this.log("Oops! Unexpected notification: " + topic);
      }
      break;
    }
  },

  /* ---------- nsIWebProgressListener  ---------- */

  onLocationChange: function(aWebProgress, aRequest, aLocation, aFlags) {
    let activetime = this._prefBranch.getIntPref("activetime");
    let nowday = Math.floor(Date.now() / (1000*60*60*24));
    if (activetime == 0) {
      this.sendTrackingHttpRequest("activate");
    } else if (activetime < nowday){  // Only send one live message each day.
      this.sendTrackingHttpRequest("live");
    }
  },

  onProgressChange: function(aWebProgress, aRequest, aCurSelfProgress,
                             aMaxSelfProgress, aCurTotalProgress,
                             aMaxTotalProgress) {
    throw "Unexpected onProgressChange";
  },

  onStatusChange: function(aWebProgress, aRequest, aStatus, aMessage) {
    throw "Unexpected onStatusChange";
  },

  onSecurityChange: function(aWebProgress, aRequest, aState) {
    throw "Unexpected onSecurityChange";
  },

  onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    throw "Unexpected onLocationChange";
  }
}; // end of CMManager implementation

var StringUtils = {
  /**
   * Format a string. Use {0}, {1} and {nth} to represent the 1st, 2nd
   * and (n+1)th arguments respectively.
   * For example:
   * var str= StringUtils.format('{0} has {1} bags', 'Ben', 4);
   * The result is 'Ben has 4 bags'.
   */
  format: function stringUtils_format(src) {
    if (arguments.length === 0) return null;
    var args = Array.prototype.slice.call(arguments, 1);
    return src.replace(/\{(\d+)\}/g, function(m, i) {
      var arg = args[i];
      if (typeof arg == 'object') {
        arg = JSON.stringify(arg);
      }
      return arg;
    });
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([CMManager]);
