package com.etwqfd.agentetc;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("agent_etc", MODE_PRIVATE);
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " agent_etc-android/1.3.0");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return false; }
        });
        web.addJavascriptInterface(new Host(), "AndroidHost");

        String url = prefs.getString("url", "");
        String token = prefs.getString("token", "");
        if (url.isEmpty()) {
            web.loadUrl("file:///android_asset/setup.html");
        } else {
            open(url, token);
        }
    }

    private void open(String url, String token) {
        String u = url;
        if (token != null && token.length() > 0) {
            u = u + (u.contains("?") ? "&" : "?") + "t=" + Uri.encode(token);
        }
        web.loadUrl(u);
    }

    public class Host {
        @JavascriptInterface
        public void save(String url, String token) {
            prefs.edit().putString("url", url).putString("token", token).apply();
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    open(url, token);
                }
            });
        }

        @JavascriptInterface
        public String getUrl() {
            return prefs.getString("url", "");
        }

        @JavascriptInterface
        public String getToken() {
            return prefs.getString("token", "");
        }

        @JavascriptInterface
        public void toast(String text) {
            Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
