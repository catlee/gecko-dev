/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.preferences;

import java.nio.ByteBuffer;
import java.text.Collator;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import org.mozilla.gecko.AppConstants.Versions;
import org.mozilla.gecko.BrowserLocaleManager;
import org.mozilla.gecko.Locales;
import org.mozilla.gecko.R;
import org.mozilla.gecko.util.ThreadUtils;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.preference.ListPreference;
import android.text.TextUtils;
import android.util.AttributeSet;
import android.util.Log;

import org.mozilla.gecko.PrefsHelper;

public class SyncServicePreference extends ListPreference {
    private static final String LOG_TAG = "GeckoSyncService";

    public static final String[] PREF_KEYS = {"identity.fxaccounts.remote.webchannel.uri",
                                              "identity.fxaccounts.remote.profile.uri",
                                              "identity.fxaccounts.remote.oauth.uri",
                                              "identity.fxaccounts.auth.uri",
                                              "identity.sync.tokenserver.uri"};
    public static final String[] PREF_LOCAL_VALUES = {"https://accounts.firefox.com.cn",
                                                "https://profile.firefox.com.cn/v1",
                                                "https://oauth.firefox.com.cn/v1",
                                                "https://api-accounts.firefox.com.cn/v1",
                                                "https://sync.firefox.com.cn/token/1.0/sync/1.5"};
    public static final String[] PREF_GLOBAL_VALUES = {"https://accounts.firefox.com",
                                                "https://profile.accounts.firefox.com/v1",
                                                "https://oauth.accounts.firefox.com/v1",
                                                "https://api.accounts.firefox.com/v1",
                                                "https://token.services.mozilla.com/1.0/sync/1.5"};
    public static final String PREF_SETTING = "app.sync.service";

    public SyncServicePreference(Context context) {
        this(context, null);
    }

    public SyncServicePreference(Context context, AttributeSet attributes) {
        super(context, attributes);

        PrefsHelper.getPref(PREF_SETTING, new PrefsHelper.PrefHandlerBase() {
            @Override
            public void prefValue(String prefName, final String value) {
                final CharSequence[] entries = getEntries();
                final CharSequence[] entryValues = getEntryValues();
                for (int i=0; i < entries.length; i++) {
                    if (value.equals(entryValues[i])) {
                        final String summary = entries[i].toString();
                        ThreadUtils.postToUiThread(new Runnable() {
                            @Override
                            public void run() {
                                setSummary(summary);
                                setValue(value);
                            }
                        });
                        break;
                    }
                }
            }
        });
    }

    @Override
    protected void onDialogClosed(boolean positiveResult) {
        // The superclass will take care of persistence.
        super.onDialogClosed(positiveResult);

        // Use this hook to try to fix up the environment ASAP.
        // Do this so that the redisplayed fragment is inflated
        // with the right locale.
        final String tag = getValue();
        int index = 0;
        if (tag == null || tag.equals("")) {
            return;
        }
        switch (tag) {
            case "local":
                for (index = 0; index < PREF_KEYS.length; index ++) {
                    PrefsHelper.setPref(PREF_KEYS[index], PREF_LOCAL_VALUES[index]);
                }
                break;
            case "global":
                for (index = 0; index < PREF_KEYS.length; index ++) {
                    PrefsHelper.setPref(PREF_KEYS[index], PREF_GLOBAL_VALUES[index]);
                }
                break;
        }
        PrefsHelper.setPref(PREF_SETTING, tag);
    }
}
