/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.compatiblemode.activities;

import org.mozilla.gecko.AppConstants.Versions;
import org.mozilla.gecko.background.common.log.Logger;
import org.mozilla.gecko.PrefsHelper;
import org.mozilla.gecko.R;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.lang.Thread;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLEncoder;
import java.util.Calendar;
import java.util.Date;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.http.SslError;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.text.TextUtils;
import android.util.Log;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.Menu;
import android.view.MotionEvent;
import android.view.View;
import android.view.View.OnClickListener;
import android.view.View.OnLongClickListener;
import android.view.View.OnTouchListener;
import android.view.ViewGroup.LayoutParams;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.CookieSyncManager;
import android.webkit.GeolocationPermissions;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebSettings.PluginState;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebView.HitTestResult;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.PopupWindow;
import android.widget.ProgressBar;
import android.widget.RelativeLayout;
import android.widget.TextView;
import android.widget.Toast;

public class CompatibleModeActivity extends Activity {
  private final static String LOG_TAG = "CompatibleModeActivity";
  private static final String PANELTAG = "CompatibleMode:";
  private final static int FILECHOOSER_RESULTCODE = 1;
  private float screenScale;
  private float screenWidth;
  private boolean isLoading;
  private Activity mActivity;
  private FrameLayout mFullscreenContainer;
  private FrameLayout mContentView;
  private GestureDetector mGestureDetector;
  private GestureListener mGestureListener;
  private CustomPopWindow mMenuPopWindow;
  private CustomPopWindow mLongClickPopWindow;
  private PopWindowMenu mPopWindowMenu;
  private ProgressBar mWebviewProgressBar;
  private RelativeLayout mWebviewHeader;
  private ValueCallback<Uri> mUploadMessage;
  private View mCustomView = null;
  private View mWebviewHeaderLine;
  private WebView mWebView;
  private WebviewLongClickedListener mWebviewLongClickedListener;
  private String mCurUrl;
  private String mCustomCompatibleUrls;
  private String mServerCompatibleUrls;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().requestFeature(Window.FEATURE_PROGRESS);
    setContentView(R.layout.compatible_mode_ui);
    // Extract URI to launch from Intent.
    Uri uri = this.getIntent().getData();
    if (uri == null) {
      Logger.debug(LOG_TAG, "No URI passed to display.");
      finishCompatibleMode();
      return;
    }
    mActivity = this;
    this.screenScale = getResources().getDisplayMetrics().density;
    this.screenWidth = getResources().getDisplayMetrics().widthPixels;

    this.mWebviewHeader =
      (RelativeLayout) findViewById(R.id.compatible_mode_header);
    this.mWebviewHeaderLine =
      findViewById(R.id.compatible_mode_header_line);
    this.mWebviewProgressBar =
      (ProgressBar) findViewById(R.id.compatible_mode_progress_bar);
    this.mWebviewProgressBar.setVisibility(View.GONE);
    this.mGestureListener = new GestureListener();
    this.mGestureDetector = new GestureDetector(this, mGestureListener);
    this.mWebviewLongClickedListener = new WebviewLongClickedListener();

    resetAllCookie();
    mWebView = (WebView) findViewById(R.id.compatible_mode_engine);
    WebSettings s = mWebView.getSettings();
    s.setDefaultTextEncodingName("UTF-8");
    s.setJavaScriptEnabled(true);
    s.setAllowFileAccess(true);
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    s.setSupportZoom(true);
    s.setBuiltInZoomControls(true);
    s.setLoadsImagesAutomatically(true);
    s.setPluginState(WebSettings.PluginState.ON);
    s.setJavaScriptCanOpenWindowsAutomatically(true);
    s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NARROW_COLUMNS);
    s.setUseWideViewPort(true);
    s.setSavePassword(true);
    s.setSaveFormData(true);
    s.setMinimumFontSize(8);
    s.setMinimumLogicalFontSize(8);
    s.setDefaultFontSize(16);
    s.setDefaultFixedFontSize(13);
    s.setNeedInitialFocus(true);
    s.setSupportMultipleWindows(true);
    s.setBlockNetworkImage(false);
    s.setLoadWithOverviewMode(true);

    // enable navigator.geolocation
    String databasePath =
      this.getApplicationContext().getDir("database",
                                          Context.MODE_PRIVATE).getPath();
    s.setDomStorageEnabled(true);
    s.setGeolocationDatabasePath(databasePath);
    s.setGeolocationEnabled(true);

    //Android 4.0 need enable hardware acceleration
    if (Build.VERSION.SDK_INT >= 14) {
      getWindow().setFlags(0x1000000, 0x1000000);
    }
    mFullscreenContainer =
      (FrameLayout) findViewById(R.id.fullscreen_custom_content);
    mContentView = (FrameLayout) findViewById(R.id.main_content);
    this.registerForContextMenu(mWebView);

    mCustomCompatibleUrls = null;
    mServerCompatibleUrls = null;
    PrefsHelper.getPref("compatiblemode.custom.urls", new PrefsHelper.PrefHandlerBase() {
      @Override
      public void prefValue(String pref, final String value) {
        if (!TextUtils.isEmpty(value)) {
          mCustomCompatibleUrls = value;
        } else {
          mCustomCompatibleUrls = "";
        }
      }
    });
    PrefsHelper.getPref("compatiblemode.server.urls", new PrefsHelper.PrefHandlerBase() {
      @Override
      public void prefValue(String pref, final String value) {
        if (!TextUtils.isEmpty(value)) {
          mServerCompatibleUrls = value;
        }
      }
    });
    mCurUrl = uri.toString();
    mWebView.setScrollBarStyle(0);
    mWebView.setOnLongClickListener(this.mWebviewLongClickedListener);
    mWebView.setWebChromeClient(new CustomWebChromeClient());
    mWebView.setWebViewClient(new CustomWebViewClient());
    mWebView.loadUrl(mCurUrl);
    setFocusToView();

    ImageButton buttonClose =
      (ImageButton) findViewById(R.id.compatible_mode_close);
    buttonClose.setOnClickListener(new View.OnClickListener() {
      public void onClick(View view) {
        finishCompatibleMode();
      }
    });
    ImageButton buttonMenu =
      (ImageButton) findViewById(R.id.compatible_mode_menu);
    buttonMenu.setOnClickListener(new View.OnClickListener() {
      public void onClick(View view) {
        String curUrl = mWebView.getUrl();
        if (curUrl != null) {
          mCurUrl = curUrl;
        }
        if (mCurUrl == null || mCurUrl.equals("")) {
          return;
        }
        if (!mCurUrl.startsWith("http://") &&
            !mCurUrl.startsWith("https://")) {
          mCurUrl = "http://" + mCurUrl;
        }
        mMenuPopWindow = new CustomPopWindow(CompatibleModeActivity.this,
          CustomPopWindow.MENU_VIEW_POPUPWINDOW);
        Button buttonBack =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_back);
        if (mWebView.canGoBack()) {
          buttonBack.setEnabled(true);
        } else {
          buttonBack.setEnabled(false);
        }
        buttonBack.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            mWebView.goBack();
            mMenuPopWindow.dismiss();
          }
        });
        Button buttonForward =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_forward);
        if (mWebView.canGoForward()) {
          buttonForward.setEnabled(true);
        } else {
          buttonForward.setEnabled(false);
        }
        buttonForward.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            mWebView.goForward();
            mMenuPopWindow.dismiss();
          }
        });
        Button buttonStop =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_stop);
        buttonStop.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            mWebView.pauseTimers();
            mWebView.stopLoading();
            mMenuPopWindow.dismiss();
          }
        });
        Button buttonRefresh =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_refresh);
        if (isLoading) {
          buttonRefresh.setVisibility(View.INVISIBLE);
        } else {
          buttonStop.setVisibility(View.INVISIBLE);
        }
        buttonRefresh.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            mWebView.reload();
            mMenuPopWindow.dismiss();
          }
        });
        Button buttonSave =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_save);
        buttonSave.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            // In API Level 11 and above, CLIPBOARD_SERVICE returns
            // android.content.ClipboardManager,
            // which is a subclass of android.text.ClipboardManager.
            final android.content.ClipboardManager cm =
              (android.content.ClipboardManager)
                mActivity.getSystemService(Context.CLIPBOARD_SERVICE);
            final ClipData clip = ClipData.newPlainText("Text",
                                                        mWebView.getUrl());
            try {
              cm.setPrimaryClip(clip);
            } catch (NullPointerException e) {
              // Bug 776223: This is a Samsung clipboard bug.
              // setPrimaryClip() can throw a NullPointerException
              // if Samsung's /data/clipboard directory is full.
              // Fortunately, the text is still successfully copied
              // to the clipboard.
            }

            Toast.makeText(CompatibleModeActivity.this,
                       getString(R.string.compatible_mode_save_url),
                       Toast.LENGTH_SHORT).show();
            mMenuPopWindow.dismiss();
            setFocusToView();
          }
        });

        int width = (int) (150 * screenScale + 0.5f);
        int X = (int) (screenWidth - width - 20);
        int Y = (int) (60 * screenScale + 0.5f);

        Button buttonAdd =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_add);
        Button buttonRemove =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_remove);
        buttonAdd.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            if (mCustomCompatibleUrls.length() > 0) {
              mCustomCompatibleUrls = mCustomCompatibleUrls + "|";
            }
            mCustomCompatibleUrls = mCustomCompatibleUrls + mCurUrl;
            PrefsHelper.setPref("compatiblemode.custom.urls", mCustomCompatibleUrls);
            mMenuPopWindow.dismiss();
          }
        });
        buttonRemove.setOnClickListener(new View.OnClickListener() {
          public void onClick(View view) {
            if (mCustomCompatibleUrls.indexOf(mCurUrl) > 0) {
              mCustomCompatibleUrls = mCustomCompatibleUrls.replace("|" + mCurUrl, "");
            } else {
              if (mCustomCompatibleUrls.length() > mCurUrl.length()) {
                mCustomCompatibleUrls = mCustomCompatibleUrls.replace(mCurUrl + "|", "");
              } else {
                mCustomCompatibleUrls = mCustomCompatibleUrls.replace(mCurUrl, "");
              }
            }
            PrefsHelper.setPref("compatiblemode.custom.urls", mCustomCompatibleUrls);
            mMenuPopWindow.dismiss();
          }
        });

        String host = Uri.parse(mCurUrl).getHost();
        if (mServerCompatibleUrls != null) {
          String [] serverUrls = mServerCompatibleUrls.split("\\|");
          for (int i = 0; i < serverUrls.length; i ++) {
            if (serverUrls[i].equals("") || host.indexOf(serverUrls[i]) < 0) {
              continue;
            }
            View viewDivider =
              mMenuPopWindow.getView(R.id.item_clicked_save_divider);
            viewDivider.setVisibility(View.GONE);
            buttonAdd.setVisibility(View.GONE);
            buttonRemove.setVisibility(View.GONE);
            mMenuPopWindow.showAtLocation(view, Gravity.TOP | Gravity.LEFT, X, Y);
            return;
          }
        }
        if (mCustomCompatibleUrls != null) {
          String [] customUrls = mCustomCompatibleUrls.split("\\|");
          for (int i = 0; i < customUrls.length; i ++) {
            if (!customUrls[i].equals(mCurUrl)) {
              continue;
            }
            buttonAdd.setVisibility(View.INVISIBLE);
            buttonRemove.setVisibility(View.VISIBLE);
            mMenuPopWindow.showAtLocation(view, Gravity.TOP | Gravity.LEFT, X, Y);
            return;
          }
        }
        buttonAdd.setVisibility(View.VISIBLE);
        buttonRemove.setVisibility(View.INVISIBLE);
        mMenuPopWindow.showAtLocation(view, Gravity.TOP | Gravity.LEFT, X, Y);
      }
    });
  }

  private void resetAllCookie() {
    CookieSyncManager cookieSyncManager =
      CookieSyncManager.createInstance(this);
    CookieSyncManager.getInstance().startSync();
    CookieManager cookieManager = CookieManager.getInstance();
    cookieManager.setAcceptCookie(true);
    cookieManager.removeSessionCookie();
    cookieManager.removeAllCookie();
    cookieSyncManager.sync();
  }

  @Override
  public boolean dispatchTouchEvent(MotionEvent ev) {
    if (mGestureDetector != null && mGestureDetector.onTouchEvent(ev)) {
      return true;
    }
    return super.dispatchTouchEvent(ev);
  }

  @Override
  protected void onActivityResult(int requestCode,
                                  int resultCode, Intent intent) {
    if (requestCode == FILECHOOSER_RESULTCODE) {
      if (null == mUploadMessage)
          return;
      Uri result =
        intent == null || resultCode != RESULT_OK ? null : intent.getData();
      mUploadMessage.onReceiveValue(result);
      mUploadMessage = null;
    }
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    Uri oldUri = this.getIntent().getData();
    Uri newUri = intent.getData();
    if (!oldUri.toString().equals(newUri.toString())) {
      setIntent(intent);
      mWebView.loadUrl(newUri.toString());
    }
  }

  public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      if (mWebView.canGoBack()) {
        mWebView.goBack();
      } else {
        finishCompatibleMode();
      }
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  public void finishCompatibleMode() {
    //mWebView.loadUrl("about:blank");
    mActivity.finish();
  }

  public void setFocusToView() {
    mWebView.requestFocus();
    //mWebView.requestFocusFromTouch();
  }

  protected class CustomWebChromeClient extends WebChromeClient {
    private int mOriginalOrientation =
      ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
    private CustomViewCallback mCustomViewCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    public boolean onCreateWindow(WebView view,
                                  boolean dialog,
                                  boolean userGesture,
                                  Message resultMsg) {
      WebView childView = new WebView(view.getContext());
      final WebSettings childSettings = childView.getSettings();
      childSettings.setJavaScriptEnabled(true);
      childSettings.setJavaScriptCanOpenWindowsAutomatically(true);
      childView.setWebChromeClient(this);
      childView.setWebViewClient(new CustomWebViewClient() {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
          if (url != null
              && (url.startsWith("mailto:")
              || url.startsWith("geo:")
              || url.startsWith("tel:"))) {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
            return true;
          } else {
            mWebView.loadUrl(url);
            return true;
          }
        }
        @Override
        public void onPageFinished(WebView view, String url) {
          super.onPageFinished(view, url);
          view.getSettings().setJavaScriptEnabled(true);
        }
      });
      WebView.WebViewTransport transport =
        (WebView.WebViewTransport) resultMsg.obj;
      transport.setWebView(childView);
      resultMsg.sendToTarget();
      return true;
    }
    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
      onShowCustomView(view, mOriginalOrientation, callback);
      super.onShowCustomView(view, callback);
    }
    @Override
    public void onShowCustomView(View view, int requestedOrientation,
                    WebChromeClient.CustomViewCallback callback) {
      if (mCustomView != null) {
        callback.onCustomViewHidden();
        return;
      }
      if (Build.VERSION.SDK_INT >= 14) {
        mFullscreenContainer.addView(view);
        mCustomView = view;
        mCustomViewCallback = callback;
        mOriginalOrientation = getRequestedOrientation();
        mContentView.setVisibility(View.INVISIBLE);
        mFullscreenContainer.setVisibility(View.VISIBLE);
        mFullscreenContainer.bringToFront();
        setRequestedOrientation(mOriginalOrientation);
      }
    }
    @Override
    public void onHideCustomView() {
      mContentView.setVisibility(View.VISIBLE);
      if (mCustomView == null) {
          return;
      }
      mCustomView.setVisibility(View.GONE);
      mFullscreenContainer.removeView(mCustomView);
      mCustomView = null;
      mFullscreenContainer.setVisibility(View.GONE);
      try {
          mCustomViewCallback.onCustomViewHidden();
      } catch (Exception e) {
      }
      setRequestedOrientation(mOriginalOrientation);
    }
    @Override
    public void onProgressChanged(WebView view, int progress) {
      // Activities and WebViews measure progress with different scales.
      // The progress meter will automatically disappear when we reach 100%
      super.onProgressChanged(view, progress);
      if(progress == 100) {
         mWebviewProgressBar.setVisibility(View.GONE);
      } else {
         mWebviewProgressBar.setVisibility(View.VISIBLE);
         mWebviewProgressBar.setProgress(progress);
      }
    }
    @Override
    public void onReceivedTitle(WebView view, String title) {
        super.onReceivedTitle(view, title);
        TextView compatibleModeTitle =
          (TextView) findViewById(R.id.compatible_mode_title);
        compatibleModeTitle.setText(title);
    }
    @Override
    public void onGeolocationPermissionsShowPrompt(String origin,
      GeolocationPermissions.Callback callback) {
      callback.invoke(origin, true, false);
      super.onGeolocationPermissionsShowPrompt(origin, callback);
    }
  }

  protected class CustomWebViewClient extends WebViewClient {
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
      if (url != null
          && (url.startsWith("mailto:")
          || url.startsWith("geo:")
          || url.startsWith("tel:"))) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        startActivity(intent);
        return true;
      }
      mCurUrl = url;
      return false;
    }

    @Override
    public void onReceivedSslError(WebView view, final SslErrorHandler handler, SslError error) {
      final AlertDialog.Builder builder = new AlertDialog.Builder(view.getContext());
      String message = "SSL证书错误.";
          switch (error.getPrimaryError()) {
              case SslError.SSL_UNTRUSTED:
                  message = "此网站证书授权不受信任.";
                  break;
              case SslError.SSL_EXPIRED:
                  message = "网站证书已过期或还未生效";
                  break;
              case SslError.SSL_IDMISMATCH:
                  message = "此网站出具的安全证书域名与网站网址不匹配";
                  break;
              case SslError.SSL_NOTYETVALID:
                  message = "网站证书已过期或还未生效";
                  break;
          }
          message += " 要继续访问吗?";
          builder.setTitle("SSL Certificate Error");
          builder.setMessage(message);
          builder.setPositiveButton("继续", new DialogInterface.OnClickListener() {
              @Override
              public void onClick(DialogInterface dialog, int which) {
                  handler.proceed();
              }
          });
          builder.setNegativeButton("取消", new DialogInterface.OnClickListener() {
              @Override
              public void onClick(DialogInterface dialog, int which) {
                  handler.cancel();
              }
          });
          final AlertDialog dialog = builder.create();
          dialog.show();
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
      super.onPageStarted(view, url, favicon);
      isLoading = true;
      mCurUrl = url;
      mWebviewHeader.setVisibility(View.VISIBLE);
      mWebviewHeaderLine.setVisibility(View.VISIBLE);
    }

    @Override
    public void onPageFinished(WebView view, String url) {
      super.onPageFinished(view, url);
      view.getSettings().setJavaScriptEnabled(true);
      isLoading = false;
      if (Build.VERSION.SDK_INT >= 19) {
        String title = view.getTitle();
        TextView compatibleModeTitle =
          (TextView) findViewById(R.id.compatible_mode_title);
        compatibleModeTitle.setText(title);
      }
      if (mMenuPopWindow != null) {
        Button buttonStop =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_stop);
        Button buttonRefresh =
          (Button) mMenuPopWindow.getView(R.id.item_clicked_refresh);
        buttonRefresh.setVisibility(View.VISIBLE);
        buttonStop.setVisibility(View.INVISIBLE);
      }
      setFocusToView();
    }
  }

  private class GestureListener implements GestureDetector.OnGestureListener {
    @Override
    public boolean onDown(MotionEvent e) {
      return false;
    }

    @Override
    public boolean onFling(MotionEvent e1, MotionEvent e2,
                           float velocityX, float velocityY) {
      int scrollY = mWebView.getScrollY();
      if(scrollY == 0) {
        mWebviewHeader.setVisibility(View.VISIBLE);
        mWebviewHeaderLine.setVisibility(View.VISIBLE);
      } else if(scrollY > 0) {
        if (velocityY > 0) {
          mWebviewHeader.setVisibility(View.VISIBLE);
          mWebviewHeaderLine.setVisibility(View.VISIBLE);
        } else {
          mWebviewHeader.setVisibility(View.GONE);
          mWebviewHeaderLine.setVisibility(View.GONE);
        }
      }
      return false;
    }

    @Override
    public void onLongPress(MotionEvent e) {
      PointerXY.x = (int) e.getX();
      PointerXY.y = (int) e.getY();
    }

    @Override
    public boolean onScroll(MotionEvent e1, MotionEvent e2,
                            float distanceX, float distanceY) {
      return false;
    }

    @Override
    public void onShowPress(MotionEvent e) {
    }

    @Override
    public boolean onSingleTapUp(MotionEvent e) {
      return false;
    }
  }

  private static class PointerXY {
    public static int x;
    public static int y;
    public static int getX() {
      return x;
    }
    public static int getY() {
      return y;
    }
  }

  private class WebviewLongClickedListener implements OnLongClickListener {
    @Override
    public boolean onLongClick(View v) {
      HitTestResult result = ((WebView) v).getHitTestResult();
      if (null == result)
        return false;

      int type = result.getType();
      if (type == WebView.HitTestResult.UNKNOWN_TYPE)
        return false;

      if (type == WebView.HitTestResult.EDIT_TEXT_TYPE) {
        return false;
      }

      int width = (int) (120 * screenScale + 0.5f);
      int height = (int) (37 * screenScale + 0.5f);
      int X = PointerXY.getX() - width;
      int Y = PointerXY.getY() - height;
      if (Y < height)
        Y = height;

      switch (type) {
        case WebView.HitTestResult.PHONE_TYPE:
        case WebView.HitTestResult.EMAIL_TYPE:
        case WebView.HitTestResult.SRC_ANCHOR_TYPE:
          mLongClickPopWindow = new CustomPopWindow(CompatibleModeActivity.this,
            CustomPopWindow.URL_LINK_POPUPWINDOW);
          mLongClickPopWindow.
            showAtLocation(v, Gravity.TOP | Gravity.LEFT, X, Y);
          Button saveUrl =
            (Button) mLongClickPopWindow.getView(R.id.item_longclicked_saveUrl);
          mPopWindowMenu =
            new PopWindowMenu(result.getType(), result.getExtra());
          saveUrl.setOnClickListener(mPopWindowMenu);
          break;
        case WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE:
        case WebView.HitTestResult.IMAGE_TYPE:
          mLongClickPopWindow = new CustomPopWindow(
            CompatibleModeActivity.this,
            CustomPopWindow.IMAGE_VIEW_POPUPWINDOW);
          mLongClickPopWindow.
            showAtLocation(v, Gravity.TOP | Gravity.LEFT, X, Y);
          Button saveImage =
            (Button) mLongClickPopWindow.
              getView(R.id.item_longclicked_saveImage);
          mPopWindowMenu =
            new PopWindowMenu(result.getType(), result.getExtra());
          saveImage.setOnClickListener(mPopWindowMenu);
          break;
        case WebView.HitTestResult.GEO_TYPE:
        default:
          break;
      }
      return true;
    }
  }

  public class CustomPopWindow extends PopupWindow {
    public static final int URL_LINK_POPUPWINDOW = 0;
    public static final int IMAGE_VIEW_POPUPWINDOW = 1;
    public static final int MENU_VIEW_POPUPWINDOW = 2;

    private LayoutInflater mCustomPopWindowInflater;
    private View mCustomPopWindowView;
    private Context mContext;
    private int mType;

    public CustomPopWindow(Context context, int type) {
      super(context);
      this.mContext = context;
      this.mType = type;
      this.initTab();
      setWidth(LayoutParams.WRAP_CONTENT);
      setHeight(LayoutParams.WRAP_CONTENT);
      setContentView(this.mCustomPopWindowView);
      setOutsideTouchable(true);
      setFocusable(true);
    }

    private void initTab() {
      this.mCustomPopWindowInflater = LayoutInflater.from(this.mContext);
      switch(mType) {
        case URL_LINK_POPUPWINDOW:
          this.mCustomPopWindowView =
            this.mCustomPopWindowInflater.
              inflate(R.layout.compatible_mode_longclicked_url, null);
          this.mCustomPopWindowView.
            setBackgroundResource(R.drawable.compatible_mode_rounded_pop);
          this.setBackgroundDrawable(mContext.getResources().
            getDrawable(R.drawable.compatible_mode_rounded_pop));
          break;
        case IMAGE_VIEW_POPUPWINDOW:
          this.mCustomPopWindowView =
            this.mCustomPopWindowInflater.
              inflate(R.layout.compatible_mode_longclicked_img, null);
          this.mCustomPopWindowView.
            setBackgroundResource(R.drawable.compatible_mode_rounded_pop);
          this.setBackgroundDrawable(mContext.getResources().
            getDrawable(R.drawable.compatible_mode_rounded_pop));
          break;
        case MENU_VIEW_POPUPWINDOW:
          this.mCustomPopWindowView =
            this.mCustomPopWindowInflater.
              inflate(R.layout.compatible_mode_clicked_menu, null);
          this.mCustomPopWindowView.
            setBackgroundResource(R.drawable.compatible_mode_rounded_menu_pop);
          this.setBackgroundDrawable(mContext.getResources().
            getDrawable(R.drawable.compatible_mode_rounded_menu));
          break;
      }
    }

    public View getView(int id) {
      return this.mCustomPopWindowView.findViewById(id);
    }
  }

  private class PopWindowMenu implements OnClickListener{
    private int mType;
    private String mValue;
    private String mDownloadPath = "/sdcard/";

    public PopWindowMenu(int type, String value) {
      this.mType = type;
      this.mValue = value;
    }

    @Override
    public void onClick(View v) {
      setFocusToView();
      if (v.getId() == R.id.item_longclicked_saveImage) {
        final String imgName = mValue.substring(mValue.lastIndexOf("/") + 1);
        new ImageDownloadManager(CompatibleModeActivity.this).
          execute(imgName, mValue, mDownloadPath);
      } else if (v.getId() == R.id.item_longclicked_saveUrl) {
        // In API Level 11 and above, CLIPBOARD_SERVICE returns
        // android.content.ClipboardManager,
        // which is a subclass of android.text.ClipboardManager.
        final android.content.ClipboardManager cm =
          (android.content.ClipboardManager)
            mActivity.getSystemService(Context.CLIPBOARD_SERVICE);
        final ClipData clip = ClipData.newPlainText("Text", mValue);
        try {
          cm.setPrimaryClip(clip);
        } catch (NullPointerException e) {
          // Bug 776223: This is a Samsung clipboard bug.
          // setPrimaryClip() can throw a NullPointerException
          // if Samsung's /data/clipboard directory is full.
          // Fortunately, the text is still successfully copied
          // to the clipboard.
        }

        Toast.makeText(CompatibleModeActivity.this,
                       getString(R.string.compatible_mode_save_url),
                       Toast.LENGTH_SHORT).show();
      }
    }
  }

  public class ImageDownloadManager extends AsyncTask<String, String, String> {
    private File mFile;
    private Context mContext;
    private String mName;
    public ImageDownloadManager(Context context) {
      this.mContext = context;
    }
    @SuppressLint("SdCardPath")
    @Override
    protected String doInBackground(String... params) {
      if(params[2].startsWith("/sdcard/")) {
        params[2] =
          Environment.getExternalStorageDirectory()+params[2].substring(8);
      }

      try {
        URL url = new URL(params[1]);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setDoInput(true);
        conn.connect();
        InputStream inputStream = conn.getInputStream();
        Bitmap imgSave = BitmapFactory.decodeStream(inputStream);
        this.writeFile(params[0],params[2], imgSave);
        inputStream.close();
      } catch (OutOfMemoryError e) {
        Log.e(LOG_TAG, "ImageDownloadManager decodeStream() OOM!", e);
      } catch(IOException e) {
        e.printStackTrace();
      }
      return null;
    }
    @Override
    protected void onPostExecute(String result) {
      Toast.makeText(mContext,
                     getString(R.string.compatible_mode_save_image) + mName,
                     Toast.LENGTH_SHORT).show();
      super.onPostExecute(result);
    }

    public void writeFile(String fileName, String dirPath, Bitmap imgSave) {
      try {
        mName = fileName;
        File directory = new File(dirPath);
        if ((directory.exists())&&(directory.isFile())) {
          directory.delete();
        } else {
          directory.mkdirs();
        }
        this.mFile =new File(dirPath, fileName);
        if (this.mFile.exists()) {
          this.mFile.delete();
        }
        this.mFile.createNewFile();
        FileOutputStream fo = new FileOutputStream(this.mFile);
        imgSave.compress(Bitmap.CompressFormat.PNG, 100, fo);
        fo.flush();
        fo.close();
      } catch (FileNotFoundException e1) {
      } catch (IOException e2) {
        e2.printStackTrace();
      }
    }
  }
}
