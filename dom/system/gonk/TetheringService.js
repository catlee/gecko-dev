/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/systemlibs.js");

const TETHERINGSERVICE_CONTRACTID = "@mozilla.org/tethering/service;1";
const TETHERINGSERVICE_CID =
  Components.ID("{527a4121-ee5a-4651-be9c-f46f59cf7c01}");

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkManager",
                                   "@mozilla.org/network/manager;1",
                                   "nsINetworkManager");

XPCOMUtils.defineLazyServiceGetter(this, "gNetworkService",
                                   "@mozilla.org/network/service;1",
                                   "nsINetworkService");

XPCOMUtils.defineLazyServiceGetter(this, "gSettingsService",
                                   "@mozilla.org/settingsService;1",
                                   "nsISettingsService");

XPCOMUtils.defineLazyServiceGetter(this, "gMobileConnectionService",
                                   "@mozilla.org/mobileconnection/mobileconnectionservice;1",
                                   "nsIMobileConnectionService");

XPCOMUtils.defineLazyGetter(this, "gRil", function() {
  try {
    return Cc["@mozilla.org/ril;1"].getService(Ci.nsIRadioInterfaceLayer);
  } catch (e) {}

  return null;
});

const TOPIC_MOZSETTINGS_CHANGED      = "mozsettings-changed";
const TOPIC_CONNECTION_STATE_CHANGED = "network-connection-state-changed";
const TOPIC_PREF_CHANGED             = "nsPref:changed";
const TOPIC_XPCOM_SHUTDOWN           = "xpcom-shutdown";
const PREF_MANAGE_OFFLINE_STATUS     = "network.gonk.manage-offline-status";
const PREF_NETWORK_DEBUG_ENABLED     = "network.debugging.enabled";

const POSSIBLE_USB_INTERFACE_NAME = "rndis0,usb0";
const DEFAULT_USB_INTERFACE_NAME  = "rndis0";
const DEFAULT_3G_INTERFACE_NAME   = "rmnet0";
const DEFAULT_WIFI_INTERFACE_NAME = "wlan0";

// The kernel's proc entry for network lists.
const KERNEL_NETWORK_ENTRY = "/sys/class/net";

const TETHERING_TYPE_WIFI = "WiFi";
const TETHERING_TYPE_USB  = "USB";

const WIFI_FIRMWARE_AP            = "AP";
const WIFI_FIRMWARE_STATION       = "STA";
const WIFI_SECURITY_TYPE_NONE     = "open";
const WIFI_SECURITY_TYPE_WPA_PSK  = "wpa-psk";
const WIFI_SECURITY_TYPE_WPA2_PSK = "wpa2-psk";
const WIFI_CTRL_INTERFACE         = "wl0.1";

const NETWORK_INTERFACE_UP   = "up";
const NETWORK_INTERFACE_DOWN = "down";

const TETHERING_STATE_ONGOING = "ongoing";
const TETHERING_STATE_IDLE    = "idle";
const TETHERING_STATE_ACTIVE  = "active";

// Settings DB path for USB tethering.
const SETTINGS_USB_ENABLED             = "tethering.usb.enabled";
const SETTINGS_USB_IP                  = "tethering.usb.ip";
const SETTINGS_USB_PREFIX              = "tethering.usb.prefix";
const SETTINGS_USB_DHCPSERVER_STARTIP  = "tethering.usb.dhcpserver.startip";
const SETTINGS_USB_DHCPSERVER_ENDIP    = "tethering.usb.dhcpserver.endip";
const SETTINGS_USB_DNS1                = "tethering.usb.dns1";
const SETTINGS_USB_DNS2                = "tethering.usb.dns2";

// Settings DB path for WIFI tethering.
const SETTINGS_WIFI_DHCPSERVER_STARTIP = "tethering.wifi.dhcpserver.startip";
const SETTINGS_WIFI_DHCPSERVER_ENDIP   = "tethering.wifi.dhcpserver.endip";

// Settings DB patch for dun required setting.
const SETTINGS_DUN_REQUIRED = "tethering.dun.required";

// Default value for USB tethering.
const DEFAULT_USB_IP                   = "192.168.0.1";
const DEFAULT_USB_PREFIX               = "24";
const DEFAULT_USB_DHCPSERVER_STARTIP   = "192.168.0.10";
const DEFAULT_USB_DHCPSERVER_ENDIP     = "192.168.0.30";

const DEFAULT_DNS1                     = "8.8.8.8";
const DEFAULT_DNS2                     = "8.8.4.4";

const DEFAULT_WIFI_DHCPSERVER_STARTIP  = "192.168.1.10";
const DEFAULT_WIFI_DHCPSERVER_ENDIP    = "192.168.1.30";

const SETTINGS_DATA_DEFAULT_SERVICE_ID = "ril.data.defaultServiceId";
const MOBILE_DUN_CONNECT_TIMEOUT       = 30000;
const MOBILE_DUN_RETRY_INTERVAL        = 5000;
const MOBILE_DUN_MAX_RETRIES           = 5;

var debug;
function updateDebug() {
  let debugPref = false; // set default value here.
  try {
    debugPref = debugPref || Services.prefs.getBoolPref(PREF_NETWORK_DEBUG_ENABLED);
  } catch (e) {}

  if (debugPref) {
    debug = function(s) {
      dump("-*- TetheringService: " + s + "\n");
    };
  } else {
    debug = function(s) {};
  }
}
updateDebug();

function TetheringService() {
  Services.obs.addObserver(this, TOPIC_XPCOM_SHUTDOWN);
  Services.obs.addObserver(this, TOPIC_MOZSETTINGS_CHANGED);
  Services.obs.addObserver(this, TOPIC_CONNECTION_STATE_CHANGED);
  Services.prefs.addObserver(PREF_NETWORK_DEBUG_ENABLED, this);
  Services.prefs.addObserver(PREF_MANAGE_OFFLINE_STATUS, this);

  try {
    this._manageOfflineStatus =
      Services.prefs.getBoolPref(PREF_MANAGE_OFFLINE_STATUS);
  } catch(ex) {
    // Ignore.
  }

  this._dataDefaultServiceId = 0;

  // Possible usb tethering interfaces for different gonk platform.
  this.possibleInterface = POSSIBLE_USB_INTERFACE_NAME.split(",");

  // Default values for internal and external interfaces.
  this._tetheringInterface = {};
  this._tetheringInterface[TETHERING_TYPE_USB] = {
    externalInterface: DEFAULT_3G_INTERFACE_NAME,
    internalInterface: DEFAULT_USB_INTERFACE_NAME
  };
  this._tetheringInterface[TETHERING_TYPE_WIFI] = {
    externalInterface: DEFAULT_3G_INTERFACE_NAME,
    internalInterface: DEFAULT_WIFI_INTERFACE_NAME
  };

  this.tetheringSettings = {};
  this.initTetheringSettings();

  let settingsLock = gSettingsService.createLock();
  // Read the default service id for data call.
  settingsLock.get(SETTINGS_DATA_DEFAULT_SERVICE_ID, this);

  // Read usb tethering data from settings DB.
  settingsLock.get(SETTINGS_USB_IP, this);
  settingsLock.get(SETTINGS_USB_PREFIX, this);
  settingsLock.get(SETTINGS_USB_DHCPSERVER_STARTIP, this);
  settingsLock.get(SETTINGS_USB_DHCPSERVER_ENDIP, this);
  settingsLock.get(SETTINGS_USB_DNS1, this);
  settingsLock.get(SETTINGS_USB_DNS2, this);
  settingsLock.get(SETTINGS_USB_ENABLED, this);

  // Read wifi tethering data from settings DB.
  settingsLock.get(SETTINGS_WIFI_DHCPSERVER_STARTIP, this);
  settingsLock.get(SETTINGS_WIFI_DHCPSERVER_ENDIP, this);

  this._usbTetheringSettingsToRead = [SETTINGS_USB_IP,
                                      SETTINGS_USB_PREFIX,
                                      SETTINGS_USB_DHCPSERVER_STARTIP,
                                      SETTINGS_USB_DHCPSERVER_ENDIP,
                                      SETTINGS_USB_DNS1,
                                      SETTINGS_USB_DNS2,
                                      SETTINGS_USB_ENABLED,
                                      SETTINGS_WIFI_DHCPSERVER_STARTIP,
                                      SETTINGS_WIFI_DHCPSERVER_ENDIP];

  this.wantConnectionEvent = null;

  this.dunConnectTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

  this.dunRetryTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

  this._pendingTetheringRequests = [];
}
TetheringService.prototype = {
  classID:   TETHERINGSERVICE_CID,
  classInfo: XPCOMUtils.generateCI({classID: TETHERINGSERVICE_CID,
                                    contractID: TETHERINGSERVICE_CONTRACTID,
                                    classDescription: "Tethering Service",
                                    interfaces: [Ci.nsITetheringService]}),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsITetheringService,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver,
                                         Ci.nsISettingsServiceCallback]),

  // Flag to record the default client id for data call.
  _dataDefaultServiceId: null,

  // Number of usb tehering requests to be processed.
  _usbTetheringRequestCount: 0,

  // Usb tethering state.
  _usbTetheringAction: TETHERING_STATE_IDLE,

  // Tethering settings.
  tetheringSettings: null,

  // Tethering settings need to be read from settings DB.
  _usbTetheringSettingsToRead: null,

  // Previous usb tethering enabled state.
  _oldUsbTetheringEnabledState: null,

  // External and internal interface name.
  _tetheringInterface: null,

  // Dun connection timer.
  dunConnectTimer: null,

  // Dun connection retry times.
  dunRetryTimes: 0,

  // Dun retry timer.
  dunRetryTimer: null,

  // Pending tethering request to handle after dun is connected.
  _pendingTetheringRequests: null,

  // Flag to indicate wether wifi tethering is being processed.
  _wifiTetheringRequestOngoing: false,

  // Arguments for pending wifi tethering request.
  _pendingWifiTetheringRequestArgs: null,

  // The state of tethering.
  state: Ci.nsITetheringService.TETHERING_STATE_INACTIVE,

  // Flag to check if we can modify the Services.io.offline.
  _manageOfflineStatus: true,

  // nsIObserver

  observe: function(aSubject, aTopic, aData) {
    let network;

    switch(aTopic) {
      case TOPIC_PREF_CHANGED:
        if (aData === PREF_NETWORK_DEBUG_ENABLED) {
          updateDebug();
        }
        break;
      case TOPIC_MOZSETTINGS_CHANGED:
        if ("wrappedJSObject" in aSubject) {
          aSubject = aSubject.wrappedJSObject;
        }
        this.handle(aSubject.key, aSubject.value);
        break;
      case TOPIC_CONNECTION_STATE_CHANGED:
        network = aSubject.QueryInterface(Ci.nsINetworkInfo);
        debug("Network " + network.type + "/" + network.name +
              " changed state to " + network.state);
        this.onConnectionChanged(network);
        break;
      case TOPIC_XPCOM_SHUTDOWN:
        Services.obs.removeObserver(this, TOPIC_XPCOM_SHUTDOWN);
        Services.obs.removeObserver(this, TOPIC_MOZSETTINGS_CHANGED);
        Services.obs.removeObserver(this, TOPIC_CONNECTION_STATE_CHANGED);
        Services.prefs.removeObserver(PREF_NETWORK_DEBUG_ENABLED, this);
        Services.prefs.removeObserver(PREF_MANAGE_OFFLINE_STATUS, this);

        this.dunConnectTimer.cancel();
        this.dunRetryTimer.cancel();
        break;
      case PREF_MANAGE_OFFLINE_STATUS:
        try {
          this._manageOfflineStatus =
            Services.prefs.getBoolPref(PREF_MANAGE_OFFLINE_STATUS);
        } catch(ex) {
          // Ignore.
        }
        break;
    }
  },

  // nsISettingsServiceCallback

  handle: function(aName, aResult) {
    switch(aName) {
      case SETTINGS_DATA_DEFAULT_SERVICE_ID:
        this._dataDefaultServiceId = aResult || 0;
        debug("'_dataDefaultServiceId' is now " + this._dataDefaultServiceId);
        break;
      case SETTINGS_USB_ENABLED:
        this._oldUsbTetheringEnabledState = this.tetheringSettings[SETTINGS_USB_ENABLED];
      case SETTINGS_USB_IP:
      case SETTINGS_USB_PREFIX:
      case SETTINGS_USB_DHCPSERVER_STARTIP:
      case SETTINGS_USB_DHCPSERVER_ENDIP:
      case SETTINGS_USB_DNS1:
      case SETTINGS_USB_DNS2:
      case SETTINGS_WIFI_DHCPSERVER_STARTIP:
      case SETTINGS_WIFI_DHCPSERVER_ENDIP:
        if (aResult !== null) {
          this.tetheringSettings[aName] = aResult;
        }
        debug("'" + aName + "'" + " is now " + this.tetheringSettings[aName]);
        let index = this._usbTetheringSettingsToRead.indexOf(aName);

        if (index != -1) {
          this._usbTetheringSettingsToRead.splice(index, 1);
        }

        if (this._usbTetheringSettingsToRead.length) {
          debug("We haven't read completely the usb Tethering data from settings db.");
          break;
        }

        if (this._oldUsbTetheringEnabledState === this.tetheringSettings[SETTINGS_USB_ENABLED]) {
          debug("No changes for SETTINGS_USB_ENABLED flag. Nothing to do.");
          this.handlePendingWifiTetheringRequest();
          break;
        }

        this._usbTetheringRequestCount++;
        if (this._usbTetheringRequestCount === 1) {
          if (this._wifiTetheringRequestOngoing) {
            debug('USB tethering request is blocked by ongoing wifi tethering request.');
          } else {
            this.handleLastUsbTetheringRequest();
          }
        }
        break;
    };
  },

  handleError: function(aErrorMessage) {
    debug("There was an error while reading Tethering settings.");
    this.tetheringSettings = {};
    this.tetheringSettings[SETTINGS_USB_ENABLED] = false;
  },

  initTetheringSettings: function() {
    this.tetheringSettings[SETTINGS_USB_ENABLED] = false;
    this.tetheringSettings[SETTINGS_USB_IP] = DEFAULT_USB_IP;
    this.tetheringSettings[SETTINGS_USB_PREFIX] = DEFAULT_USB_PREFIX;
    this.tetheringSettings[SETTINGS_USB_DHCPSERVER_STARTIP] = DEFAULT_USB_DHCPSERVER_STARTIP;
    this.tetheringSettings[SETTINGS_USB_DHCPSERVER_ENDIP] = DEFAULT_USB_DHCPSERVER_ENDIP;
    this.tetheringSettings[SETTINGS_USB_DNS1] = DEFAULT_DNS1;
    this.tetheringSettings[SETTINGS_USB_DNS2] = DEFAULT_DNS2;

    this.tetheringSettings[SETTINGS_WIFI_DHCPSERVER_STARTIP] = DEFAULT_WIFI_DHCPSERVER_STARTIP;
    this.tetheringSettings[SETTINGS_WIFI_DHCPSERVER_ENDIP]   = DEFAULT_WIFI_DHCPSERVER_ENDIP;

    this.tetheringSettings[SETTINGS_DUN_REQUIRED] =
      libcutils.property_get("ro.tethering.dun_required") === "1";
  },

  getNetworkInfo: function(aType, aServiceId) {
    for (let networkId in gNetworkManager.allNetworkInfo) {
      let networkInfo = gNetworkManager.allNetworkInfo[networkId];
      if (networkInfo.type == aType) {
        try {
          if (networkInfo instanceof Ci.nsIRilNetworkInfo) {
            let rilNetwork = networkInfo.QueryInterface(Ci.nsIRilNetworkInfo);
            if (rilNetwork.serviceId != aServiceId) {
              continue;
            }
          }
        } catch (e) {}
        return networkInfo;
      }
    }
    return null;
  },

  handleLastUsbTetheringRequest: function() {
    debug('handleLastUsbTetheringRequest... ' + this._usbTetheringRequestCount);

    if (this._usbTetheringRequestCount === 0) {
      if (this.wantConnectionEvent) {
        if (this.tetheringSettings[SETTINGS_USB_ENABLED]) {
          this.wantConnectionEvent.call(this);
        }
        this.wantConnectionEvent = null;
      }
      this.handlePendingWifiTetheringRequest();
      return;
    }

    // Cancel the accumlated count to 1 since we only care about the
    // last state.
    this._usbTetheringRequestCount = 1;
    this.handleUSBTetheringToggle(this.tetheringSettings[SETTINGS_USB_ENABLED]);
    this.wantConnectionEvent = null;
  },

  handlePendingWifiTetheringRequest: function() {
    if (this._pendingWifiTetheringRequestArgs) {
      this.setWifiTethering.apply(this, this._pendingWifiTetheringRequestArgs);
      this._pendingWifiTetheringRequestArgs = null;
    }
  },

  /**
   * Callback when dun connection fails to connect within timeout.
   */
  onDunConnectTimerTimeout: function() {
    while (this._pendingTetheringRequests.length > 0) {
      debug("onDunConnectTimerTimeout: callback without network info.");
      let callback = this._pendingTetheringRequests.shift();
      if (typeof callback === 'function') {
        callback();
      }
    }
  },

  setupDunConnection: function() {
    this.dunRetryTimer.cancel();
    let connection =
      gMobileConnectionService.getItemByServiceId(this._dataDefaultServiceId);
    let data = connection && connection.data;
    if (data && data.state === "registered") {
      let ril = gRil.getRadioInterface(this._dataDefaultServiceId);

      this.dunRetryTimes = 0;
      ril.setupDataCallByType(Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE_DUN);
      this.dunConnectTimer.cancel();
      this.dunConnectTimer.
        initWithCallback(this.onDunConnectTimerTimeout.bind(this),
                         MOBILE_DUN_CONNECT_TIMEOUT, Ci.nsITimer.TYPE_ONE_SHOT);
      return;
    }

    if (this.dunRetryTimes++ >= this.MOBILE_DUN_MAX_RETRIES) {
      debug("setupDunConnection: max retries reached.");
      this.dunRetryTimes = 0;
      // same as dun connect timeout.
      this.onDunConnectTimerTimeout();
      return;
    }

    debug("Data not ready, retry dun after " + MOBILE_DUN_RETRY_INTERVAL + " ms.");
    this.dunRetryTimer.
      initWithCallback(this.setupDunConnection.bind(this),
                       MOBILE_DUN_RETRY_INTERVAL, Ci.nsITimer.TYPE_ONE_SHOT);
  },

  _dunActiveUsers: 0,
  handleDunConnection: function(aEnable, aCallback) {
    debug("handleDunConnection: " + aEnable);
    let dun = this.getNetworkInfo(
      Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE_DUN, this._dataDefaultServiceId);

    if (!aEnable) {
      this._dunActiveUsers--;
      if (this._dunActiveUsers > 0) {
        debug("Dun still needed by others, do not disconnect.")
        return;
      }

      this.dunRetryTimes = 0;
      this.dunRetryTimer.cancel();
      this.dunConnectTimer.cancel();
      this._pendingTetheringRequests = [];

      if (dun && (dun.state == Ci.nsINetworkInfo.NETWORK_STATE_CONNECTED)) {
        gRil.getRadioInterface(this._dataDefaultServiceId)
          .deactivateDataCallByType(Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE_DUN);
      }
      return;
    }

    this._dunActiveUsers++;
    if (!dun || (dun.state != Ci.nsINetworkInfo.NETWORK_STATE_CONNECTED)) {
      debug("DUN data call inactive, setup dun data call!")
      this._pendingTetheringRequests.push(aCallback);
      this.dunRetryTimes = 0;
      this.setupDunConnection();

      return;
    }

    this._tetheringInterface[TETHERING_TYPE_USB].externalInterface = dun.name;
    aCallback(dun);
  },

  handleUSBTetheringToggle: function(aEnable) {
    debug("handleUSBTetheringToggle: " + aEnable);
    if (aEnable &&
        (this._usbTetheringAction === TETHERING_STATE_ONGOING ||
         this._usbTetheringAction === TETHERING_STATE_ACTIVE)) {
      debug("Usb tethering already connecting/connected.");
      this._usbTetheringRequestCount = 0;
      this.handlePendingWifiTetheringRequest();
      return;
    }

    if (!aEnable &&
        this._usbTetheringAction === TETHERING_STATE_IDLE) {
      debug("Usb tethering already disconnected.");
      this._usbTetheringRequestCount = 0;
      this.handlePendingWifiTetheringRequest();
      return;
    }

    if (!aEnable) {
      this.tetheringSettings[SETTINGS_USB_ENABLED] = false;
      gNetworkService.enableUsbRndis(false, this.enableUsbRndisResult.bind(this));
      return;
    }

    this.tetheringSettings[SETTINGS_USB_ENABLED] = true;
    this._usbTetheringAction = TETHERING_STATE_ONGOING;

    if (this.tetheringSettings[SETTINGS_DUN_REQUIRED]) {
      this.handleDunConnection(true, (aNetworkInfo) => {
        if (!aNetworkInfo){
          this.usbTetheringResultReport(aEnable, "Dun connection failed");
          return;
        }
        this._tetheringInterface[TETHERING_TYPE_USB].externalInterface =
          aNetworkInfo.name;
        gNetworkService.enableUsbRndis(true, this.enableUsbRndisResult.bind(this));
      });
      return;
    }

    if (gNetworkManager.activeNetworkInfo) {
      this._tetheringInterface[TETHERING_TYPE_USB].externalInterface =
        gNetworkManager.activeNetworkInfo.name;
    } else {
      let mobile = this.getNetworkInfo(
        Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE, this._dataDefaultServiceId);
      if (mobile && mobile.name) {
        this._tetheringInterface[TETHERING_TYPE_USB].externalInterface = mobile.name;
      }
    }
    gNetworkService.enableUsbRndis(true, this.enableUsbRndisResult.bind(this));
  },

  getUSBTetheringParameters: function(aEnable, aTetheringInterface) {
    let interfaceIp = this.tetheringSettings[SETTINGS_USB_IP];
    let prefix = this.tetheringSettings[SETTINGS_USB_PREFIX];
    let wifiDhcpStartIp = this.tetheringSettings[SETTINGS_WIFI_DHCPSERVER_STARTIP];
    let wifiDhcpEndIp = this.tetheringSettings[SETTINGS_WIFI_DHCPSERVER_ENDIP];
    let usbDhcpStartIp = this.tetheringSettings[SETTINGS_USB_DHCPSERVER_STARTIP];
    let usbDhcpEndIp = this.tetheringSettings[SETTINGS_USB_DHCPSERVER_ENDIP];
    let dns1 = this.tetheringSettings[SETTINGS_USB_DNS1];
    let dns2 = this.tetheringSettings[SETTINGS_USB_DNS2];
    let internalInterface = aTetheringInterface.internalInterface;
    let externalInterface = aTetheringInterface.externalInterface;

    // Using the default values here until application support these settings.
    if (interfaceIp == "" || prefix == "" ||
        wifiDhcpStartIp == "" || wifiDhcpEndIp == "" ||
        usbDhcpStartIp == "" || usbDhcpEndIp == "") {
      debug("Invalid subnet information.");
      return null;
    }

    return {
      ifname: internalInterface,
      ip: interfaceIp,
      prefix: prefix,
      wifiStartIp: wifiDhcpStartIp,
      wifiEndIp: wifiDhcpEndIp,
      usbStartIp: usbDhcpStartIp,
      usbEndIp: usbDhcpEndIp,
      dns1: dns1,
      dns2: dns2,
      internalIfname: internalInterface,
      externalIfname: externalInterface,
      enable: aEnable,
      link: aEnable ? NETWORK_INTERFACE_UP : NETWORK_INTERFACE_DOWN
    };
  },

  notifyError: function(aResetSettings, aCallback, aMsg) {
    if (aResetSettings) {
      let settingsLock = gSettingsService.createLock();
      // Disable wifi tethering with a useful error message for the user.
      settingsLock.set("tethering.wifi.enabled", false, null, aMsg);
    }

    debug("setWifiTethering: " + (aMsg ? aMsg : "success"));

    if (aCallback) {
      // Callback asynchronously to avoid netsted toggling.
      Services.tm.dispatchToMainThread(() => {
        aCallback.wifiTetheringEnabledChange(aMsg);
      });
    }
  },

  enableWifiTethering: function(aEnable, aConfig, aCallback) {
    // Fill in config's required fields.
    aConfig.ifname         = this._tetheringInterface[TETHERING_TYPE_WIFI].internalInterface;
    aConfig.internalIfname = this._tetheringInterface[TETHERING_TYPE_WIFI].internalInterface;
    aConfig.externalIfname = this._tetheringInterface[TETHERING_TYPE_WIFI].externalInterface;

    this._wifiTetheringRequestOngoing = true;
    gNetworkService.setWifiTethering(aEnable, aConfig, (aError) => {
      // Change the tethering state to WIFI if there is no error.
      if (aEnable && !aError) {
        this.state = Ci.nsITetheringService.TETHERING_STATE_WIFI;
      } else {
        // If wifi thethering is disable, or any error happens,
          // then consider the following statements.

        // Check whether the state is USB now or not. If no then just change
          // it to INACTIVE, if yes then just keep it.
          // It means that don't let the disable or error of WIFI affect
          // the original active state.
        if (this.state != Ci.nsITetheringService.TETHERING_STATE_USB) {
          this.state = Ci.nsITetheringService.TETHERING_STATE_INACTIVE;
        }

        // Disconnect dun on error or when wifi tethering is disabled.
        if (this.tetheringSettings[SETTINGS_DUN_REQUIRED]) {
          this.handleDunConnection(false);
        }
      }

      if (this._manageOfflineStatus) {
        Services.io.offline = !this.isAnyConnected() &&
                              (this.state ===
                               Ci.nsITetheringService.TETHERING_STATE_INACTIVE);
      }

      let resetSettings = aError;
      debug('gNetworkService.setWifiTethering finished');
      this.notifyError(resetSettings, aCallback, aError);
      this._wifiTetheringRequestOngoing = false;
      if (this._usbTetheringRequestCount > 0) {
        debug('Perform pending USB tethering requests.');
        this.handleLastUsbTetheringRequest();
      }
    });
  },

  // Enable/disable WiFi tethering by sending commands to netd.
  setWifiTethering: function(aEnable, aInterfaceName, aConfig, aCallback) {
    debug("setWifiTethering: " + aEnable);
    if (!aInterfaceName) {
      this.notifyError(true, aCallback, "invalid network interface name");
      return;
    }

    if (!aConfig) {
      this.notifyError(true, aCallback, "invalid configuration");
      return;
    }

    if (this._usbTetheringRequestCount > 0) {
      // If there's still pending usb tethering request, save
      // the request params and redo |setWifiTethering| on
      // usb tethering task complete.
      debug('USB tethering request is being processed. Queue this wifi tethering request.');
      this._pendingWifiTetheringRequestArgs = Array.prototype.slice.call(arguments);
      debug('Pending args: ' + JSON.stringify(this._pendingWifiTetheringRequestArgs));
      return;
    }

    // Re-check again, test cases set this property later.
    this.tetheringSettings[SETTINGS_DUN_REQUIRED] =
      libcutils.property_get("ro.tethering.dun_required") === "1";

    if (!aEnable) {
      this.enableWifiTethering(false, aConfig, aCallback);
      return;
    }

    this._tetheringInterface[TETHERING_TYPE_WIFI].internalInterface =
      aInterfaceName;

    if (this.tetheringSettings[SETTINGS_DUN_REQUIRED]) {
      this.handleDunConnection(true, (aNetworkInfo) => {
        if (!aNetworkInfo) {
          this.notifyError(true, aCallback, "Dun connection failed");
          return;
        }
        this._tetheringInterface[TETHERING_TYPE_WIFI].externalInterface =
          aNetworkInfo.name;
        this.enableWifiTethering(true, aConfig, aCallback);
      });
      return;
    }

    let mobile = this.getNetworkInfo(
      Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE, this._dataDefaultServiceId);
    // Update the real interface name
    if (mobile && mobile.name) {
      this._tetheringInterface[TETHERING_TYPE_WIFI].externalInterface = mobile.name;
    }

    this.enableWifiTethering(true, aConfig, aCallback);
  },

  // Enable/disable USB tethering by sending commands to netd.
  setUSBTethering: function(aEnable, aTetheringInterface, aCallback) {
    let params = this.getUSBTetheringParameters(aEnable, aTetheringInterface);

    if (params === null) {
      gNetworkService.enableUsbRndis(false, function() {
        this.usbTetheringResultReport(aEnable, "Invalid parameters");
      });
      return;
    }

    gNetworkService.setUSBTethering(aEnable, params, aCallback);
  },

  getUsbInterface: function() {
    // Find the rndis interface.
    for (let i = 0; i < this.possibleInterface.length; i++) {
      try {
        let file = new FileUtils.File(KERNEL_NETWORK_ENTRY + "/" +
                                      this.possibleInterface[i]);
        if (file.exists()) {
          return this.possibleInterface[i];
        }
      } catch (e) {
        debug("Not " + this.possibleInterface[i] + " interface.");
      }
    }
    debug("Can't find rndis interface in possible lists.");
    return DEFAULT_USB_INTERFACE_NAME;
  },

  enableUsbRndisResult: function(aSuccess, aEnable) {
    if (aSuccess) {
      // If enable is false, don't find usb interface cause it is already down,
      // just use the internal interface in settings.
      if (aEnable) {
        this._tetheringInterface[TETHERING_TYPE_USB].internalInterface =
          this.getUsbInterface();
      }
      this.setUSBTethering(aEnable,
                           this._tetheringInterface[TETHERING_TYPE_USB],
                           this.usbTetheringResultReport.bind(this, aEnable));
    } else {
      this.usbTetheringResultReport(aEnable, "enableUsbRndisResult failure");
      throw new Error("failed to set USB Function to adb");
    }
  },

  usbTetheringResultReport: function(aEnable, aError) {
    this._usbTetheringRequestCount--;

    let settingsLock = gSettingsService.createLock();

    debug('usbTetheringResultReport callback. enable: ' + aEnable +
          ', error: ' + aError);

    // Disable tethering settings when fail to enable it.
    if (aError) {
      this.tetheringSettings[SETTINGS_USB_ENABLED] = false;
      settingsLock.set("tethering.usb.enabled", false, null);
      // Skip others request when we found an error.
      this._usbTetheringRequestCount = 0;
      this._usbTetheringAction = TETHERING_STATE_IDLE;
      // If the thethering state is WIFI now, then just keep it,
        // if not, just change the state to INACTIVE.
        // It means that don't let the error of USB affect the original active state.
      if (this.state != Ci.nsITetheringService.TETHERING_STATE_WIFI) {
        this.state = Ci.nsITetheringService.TETHERING_STATE_INACTIVE;
      }
      if (this.tetheringSettings[SETTINGS_DUN_REQUIRED]) {
        this.handleDunConnection(false);
      }
    } else {
      if (aEnable) {
        this._usbTetheringAction = TETHERING_STATE_ACTIVE;
        this.state = Ci.nsITetheringService.TETHERING_STATE_USB;
      } else {
        this._usbTetheringAction = TETHERING_STATE_IDLE;
        // If the state is now WIFI, don't let the disable of USB affect it.
        if (this.state != Ci.nsITetheringService.TETHERING_STATE_WIFI) {
          this.state = Ci.nsITetheringService.TETHERING_STATE_INACTIVE;
        }
        if (this.tetheringSettings[SETTINGS_DUN_REQUIRED]) {
          this.handleDunConnection(false);
        }
      }

      if (this._manageOfflineStatus) {
        Services.io.offline = !this.isAnyConnected() &&
                              (this.state ===
                               Ci.nsITetheringService.TETHERING_STATE_INACTIVE);
      }

      this.handleLastUsbTetheringRequest();
    }
  },

  onConnectionChangedReport: function(aSuccess, aExternalIfname) {
    debug("onConnectionChangedReport result: success " + aSuccess);

    if (aSuccess) {
      // Update the external interface.
      this._tetheringInterface[TETHERING_TYPE_USB].externalInterface =
        aExternalIfname;
      debug("Change the interface name to " + aExternalIfname);
    }
  },

  onConnectionChanged: function(aNetworkInfo) {
    if (aNetworkInfo.state != Ci.nsINetworkInfo.NETWORK_STATE_CONNECTED) {
      debug("We are only interested in CONNECTED event");
      return;
    }

    if (this.tetheringSettings[SETTINGS_DUN_REQUIRED] &&
        aNetworkInfo.type === Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE_DUN) {
      this.dunConnectTimer.cancel();
      debug("DUN data call connected, process callbacks.");
      while (this._pendingTetheringRequests.length > 0) {
        let callback = this._pendingTetheringRequests.shift();
        if (typeof callback === 'function') {
          callback(aNetworkInfo);
        }
      }
      return;
    }

    if (!this.tetheringSettings[SETTINGS_USB_ENABLED]) {
      debug("Usb tethering settings is not enabled");
      return;
    }

    if (this.tetheringSettings[SETTINGS_DUN_REQUIRED] &&
        aNetworkInfo.type === Ci.nsINetworkInfo.NETWORK_TYPE_MOBILE_DUN &&
        this._tetheringInterface[TETHERING_TYPE_USB].externalInterface ===
        aNetworkInfo.name) {
      debug("Dun required and dun interface is the same");
      return;
    }

    if (this._tetheringInterface[TETHERING_TYPE_USB].externalInterface ===
        gNetworkManager.activeNetworkInfo.name) {
      debug("The active interface is the same");
      return;
    }

    let previous = {
      internalIfname: this._tetheringInterface[TETHERING_TYPE_USB].internalInterface,
      externalIfname: this._tetheringInterface[TETHERING_TYPE_USB].externalInterface
    };

    let current = {
      internalIfname: this._tetheringInterface[TETHERING_TYPE_USB].internalInterface,
      externalIfname: aNetworkInfo.name
    };

    let callback = (() => {
      // Update external network interface.
      debug("Update upstream interface to " + aNetworkInfo.name);
      gNetworkService.updateUpStream(previous, current,
                                     this.onConnectionChangedReport.bind(this));
    });

    if (this._usbTetheringAction === TETHERING_STATE_ONGOING) {
      debug("Postpone the event and handle it when state is idle.");
      this.wantConnectionEvent = callback;
      return;
    }
    this.wantConnectionEvent = null;

    callback.call(this);
  },

  isAnyConnected: function() {
    let allNetworkInfo = gNetworkManager.allNetworkInfo;
    for (let networkId in allNetworkInfo) {
      if (allNetworkInfo.hasOwnProperty(networkId) &&
          allNetworkInfo[networkId].state === Ci.nsINetworkInfo.NETWORK_STATE_CONNECTED) {
          return true;
      }
    }
    return false;
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([TetheringService]);
