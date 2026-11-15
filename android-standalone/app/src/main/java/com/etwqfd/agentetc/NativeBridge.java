package com.etwqfd.agentetc;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

public class NativeBridge {
    private final Activity activity;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private String pendingPickId = null;
    private String pendingWorkspaceId = null;
    private String pendingTextId = null;
    private static final int REQ_MODEL = 7001;
    private static final int REQ_WORKSPACE = 7002;
    private static final int REQ_TEXT = 7003;
    private Uri workspaceUri = null;

    public NativeBridge(Activity a, WebView w) {
        activity = a;
        web = w;
        String saved = a.getSharedPreferences("agent_etc", Context.MODE_PRIVATE).getString("workspaceUri", "");
        if (!saved.isEmpty()) {
            try { workspaceUri = Uri.parse(saved); } catch (Exception ignored) {}
        }
    }

    private void js(final String code) {
        ui.post(() -> web.evaluateJavascript(code, null));
    }

    private static String q(String s) { return JSONObject.quote(s == null ? "" : s); }

    @JavascriptInterface
    public void toast(String msg) { activity.runOnUiThread(() -> android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_SHORT).show()); }

    @JavascriptInterface
    public String deviceInfo() {
        try {
            JSONObject o = new JSONObject();
            o.put("model", Build.MODEL);
            o.put("brand", Build.BRAND);
            o.put("android", Build.VERSION.RELEASE);
            o.put("sdk", Build.VERSION.SDK_INT);
            o.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    // ---------- HTTP ----------
    @JavascriptInterface
    public void httpStart(final String id, final String method, final String url, final String headersJson, final String body) {
        new Thread(() -> {
            JSONObject out = new JSONObject();
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase());
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(120000);
                conn.setRequestProperty("User-Agent", "agent_etc-mobile/1.6.0");
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        conn.setRequestProperty(k, h.optString(k));
                    }
                }
                if (body != null && !body.isEmpty()) {
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = conn.getResponseCode();
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                StringBuilder sb = new StringBuilder();
                if (in != null) {
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                        String line;
                        int total = 0;
                        while ((line = br.readLine()) != null) {
                            sb.append(line).append('\n');
                            total += line.length();
                            if (total > 12_000_000) break;
                        }
                    }
                }
                out.put("status", status);
                out.put("body", sb.toString());
                out.put("error", "");
            } catch (Exception e) {
                try { out.put("status", 0); out.put("body", ""); out.put("error", e.getMessage() == null ? e.toString() : e.getMessage()); } catch (Exception ignored) {}
            } finally { if (conn != null) conn.disconnect(); }
            js("window.__httpResult(" + q(id) + "," + q(out.toString()) + ")");
        }).start();
    }

    // ---------- local model ----------
    // ---------- accessibility screen (user-granted) ----------
    @JavascriptInterface
    public String accessibilityEnabled() {
        return AgentAccessibilityService.isReady() ? "true" : "false";
    }

    @JavascriptInterface
    public String screenRead() {
        if (!AgentAccessibilityService.isReady()) return "{\"enabled\":false,\"error\":\"无障碍服务未开启，请在系统设置里授权 agent_etc\"}";
        return AgentAccessibilityService.dumpScreen();
    }

    @JavascriptInterface
    public String screenTap(int x, int y) { return AgentAccessibilityService.tap(x, y); }

    @JavascriptInterface
    public String screenBack() { return AgentAccessibilityService.back(); }

    @JavascriptInterface
    public String openAccessibility() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
            return "已打开系统无障碍设置；请找到 agent_etc 并开启，然后回到这里点“读一次屏幕”。";
        } catch (Exception e) { return "打开设置失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public void pickModel(final String id) {
        pendingPickId = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        ui.post(() -> activity.startActivityForResult(i, REQ_MODEL));
    }

    @JavascriptInterface
    public void pickTextFile(final String id) {
        pendingTextId = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ui.post(() -> activity.startActivityForResult(i, REQ_TEXT));
    }

    private String displayName(Uri uri, String fallback) {
        try (Cursor c = activity.getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) {}
        String seg = uri.getLastPathSegment();
        return seg == null || seg.isEmpty() ? fallback : seg;
    }

    private String readText(Uri uri, String name) throws Exception {
        String type = activity.getContentResolver().getType(uri);
        String lower = name == null ? "" : name.toLowerCase();
        boolean byExt = lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".json")
                || lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".csv")
                || lower.endsWith(".log") || lower.endsWith(".xml") || lower.endsWith(".html")
                || lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".java")
                || lower.endsWith(".py") || lower.endsWith(".sh") || lower.endsWith(".toml");
        if (type != null && !type.startsWith("text/") && !type.equals("application/json")
                && !type.equals("application/xml") && !type.equals("application/x-yaml") && !byExt) {
            throw new Exception("不是文本文件（" + type + "）");
        }
        StringBuilder sb = new StringBuilder();
        try (InputStream in = activity.getContentResolver().openInputStream(uri);
             BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                if (sb.length() + line.length() > 262144) break;
                sb.append(line).append('\n');
            }
        }
        return sb.toString();
    }

    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_TEXT) {
            final String id = pendingTextId == null ? "text" : pendingTextId;
            pendingTextId = null;
            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                js("window.__textPicked(" + q(id) + "," + q("") + "," + q("") + "," + q("已取消") + ")");
                return;
            }
            final Uri uri = data.getData();
            new Thread(() -> {
                try {
                    String name = displayName(uri, "attachment.txt");
                    String text = readText(uri, name);
                    js("window.__textPicked(" + q(id) + "," + q(name) + "," + q(text) + "," + q("") + ")");
                } catch (Exception e) {
                    js("window.__textPicked(" + q(id) + "," + q("") + "," + q("") + "," + q(String.valueOf(e.getMessage())) + ")");
                }
            }).start();
            return;
        }
        if (requestCode == REQ_WORKSPACE) {
            final String id = pendingWorkspaceId == null ? "workspace" : pendingWorkspaceId;
            pendingWorkspaceId = null;
            if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData();
                persistWorkspace(uri);
                js("window.__workspacePicked(" + q(id) + "," + q(workspaceName()) + "," + q(uri.toString()) + "," + q("") + ")");
            } else {
                js("window.__workspacePicked(" + q(id) + "," + q("") + "," + q("") + "," + q("已取消") + ")");
            }
            return;
        }
        if (requestCode != REQ_MODEL) return;
        final String id = pendingPickId == null ? "model" : pendingPickId;
        pendingPickId = null;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            js("window.__modelPicked(" + q(id) + "," + q("") + "," + q("") + ",0," + q("已取消") + ")");
            return;
        }
        final Uri uri = data.getData();
        new Thread(() -> {
            try {
                String name = "model.gguf";
                try (InputStream is = activity.getContentResolver().openInputStream(uri)) {
                    ((MainActivity) activity).toast("正在导入模型，大文件需要一点时间…");
                }
                String display = uri.getLastPathSegment();
                if (display != null) {
                    int slash = display.lastIndexOf('/');
                    if (slash >= 0) display = display.substring(slash + 1);
                    if (display.toLowerCase().endsWith(".gguf")) name = display;
                }
                File dir = new File(activity.getFilesDir(), "models");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, name.replaceAll("[^A-Za-z0-9._\\-\\u4e00-\\u9fa5]", "_"));
                try (InputStream in = activity.getContentResolver().openInputStream(uri);
                     FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n; long total = 0;
                    while ((n = in.read(buf)) > 0) { fos.write(buf, 0, n); total += n; }
                }
                final long size = out.length();
                js("window.__modelPicked(" + q(id) + "," + q(out.getName()) + "," + q(out.getAbsolutePath()) + "," + size + "," + q("") + ")");
            } catch (Exception e) {
                js("window.__modelPicked(" + q(id) + "," + q("") + "," + q("") + ",0," + q(String.valueOf(e.getMessage())) + ")");
            }
        }).start();
    }

    @JavascriptInterface
    public void rememberModel(String path, String name) {
        try {
            activity.getSharedPreferences("agent_etc", Context.MODE_PRIVATE).edit()
                    .putString("lastModelPath", path == null ? "" : path)
                    .putString("lastModelName", name == null ? "" : name).apply();
        } catch (Throwable ignored) {}
    }

    @JavascriptInterface
    public String lastModel() {
        try {
            SharedPreferences p = activity.getSharedPreferences("agent_etc", Context.MODE_PRIVATE);
            JSONObject o = new JSONObject();
            o.put("path", p.getString("lastModelPath", ""));
            o.put("name", p.getString("lastModelName", ""));
            return o.toString();
        } catch (Throwable e) { return "{}"; }
    }

    @JavascriptInterface
    public boolean localReady() {
        try { return LlamaBridge.ready(); } catch (Throwable e) { return false; }
    }

    @JavascriptInterface
    public void loadLocal(final String id, final String path, final int nCtx, final int threads) {
        new Thread(() -> {
            try {
                boolean ok = LlamaBridge.load(path, nCtx, threads, 0);
                String err = ok ? "" : LlamaBridge.lastError();
                String info = ok ? LlamaBridge.nativeInfo(LlamaBridge.getHandle()) : "{}";
                js("window.__localStatus(" + q(id) + "," + (ok ? "true" : "false") + "," + q(err) + "," + q(info) + ")");
            } catch (Throwable e) {
                js("window.__localStatus(" + q(id) + ",false," + q(String.valueOf(e.getMessage())) + ",{})");
            }
        }).start();
    }

    @JavascriptInterface
    public void localInfo(final String id) {
        try {
            String info = LlamaBridge.ready() ? LlamaBridge.nativeInfo(LlamaBridge.getHandle()) : "{}";
            js("window.__localInfo(" + q(id) + "," + q(info) + ")");
        } catch (Throwable e) { js("window.__localInfo(" + q(id) + ",{})"); }
    }

    @JavascriptInterface
    public void unloadLocal() { LlamaBridge.unload(); }

    @JavascriptInterface
    public void localChat(final String id, final String rolesJson, final String contentsJson,
                          final int maxTokens, final float temp, final float topP, final int topK) {
        new Thread(() -> {
            try {
                if (!LlamaBridge.ready()) {
                    js("window.__localReply(" + q(id) + "," + q("") + "," + q("本地模型还没有加载") + ")");
                    return;
                }
                JSONArray roles = new JSONArray(rolesJson);
                JSONArray contents = new JSONArray(contentsJson);
                int n = Math.min(roles.length(), contents.length());
                String[] r = new String[n], c = new String[n];
                for (int i = 0; i < n; i++) { r[i] = roles.optString(i, "user"); c[i] = contents.optString(i, ""); }
                String prompt = LlamaBridge.nativeBuildPrompt(LlamaBridge.getHandle(), r, c);
                if (prompt == null || prompt.isEmpty()) { js("window.__localReply(" + q(id) + "," + q("") + "," + q("提示词构建失败") + ")"); return; }
                String text = LlamaBridge.nativeGenerate(LlamaBridge.getHandle(), prompt, maxTokens, temp, topP, topK);
                if (text == null) text = "";
                String err = text.isEmpty() ? LlamaBridge.lastError() : "";
                js("window.__localReply(" + q(id) + "," + q(text) + "," + q(err) + ")");
            } catch (Throwable e) {
                js("window.__localReply(" + q(id) + "," + q("") + "," + q(String.valueOf(e.getMessage())) + ")");
            }
        }).start();
    }

    // ---------- workspace (SAF directory) ----------
    @JavascriptInterface
    public void pickWorkspace(final String id) {
        pendingWorkspaceId = id;
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        ui.post(() -> activity.startActivityForResult(i, REQ_WORKSPACE));
    }

    private boolean persistWorkspace(Uri uri) {
        try {
            activity.getContentResolver().takePersistableUriPermission(uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {}
        workspaceUri = uri;
        SharedPreferences.Editor e = activity.getSharedPreferences("agent_etc", Context.MODE_PRIVATE).edit();
        e.putString("workspaceUri", uri.toString());
        e.apply();
        return true;
    }

    private Uri rootDocUri() {
        if (workspaceUri == null) return null;
        String id = DocumentsContract.getTreeDocumentId(workspaceUri);
        return DocumentsContract.buildDocumentUriUsingTree(workspaceUri, id);
    }

    private String workspaceName() {
        Uri root = rootDocUri();
        if (root == null) return "";
        try (Cursor c = activity.getContentResolver().query(root,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        return "已选择目录";
    }

    private Uri findInWorkspace(String name) {
        Uri root = rootDocUri();
        if (root == null) return null;
        String rootId = DocumentsContract.getTreeDocumentId(workspaceUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(workspaceUri, rootId);
        try (Cursor c = activity.getContentResolver().query(children,
                new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                null, null, null)) {
            if (c != null) while (c.moveToNext()) {
                if (name.equals(c.getString(1))) {
                    return DocumentsContract.buildDocumentUriUsingTree(workspaceUri, c.getString(0));
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    @JavascriptInterface
    public String workspaceInfo() {
        try {
            JSONObject o = new JSONObject();
            o.put("ready", workspaceUri != null);
            o.put("name", workspaceUri == null ? "" : workspaceName());
            o.put("uri", workspaceUri == null ? "" : workspaceUri.toString());
            return o.toString();
        } catch (Exception e) { return "{\"ready\":false}"; }
    }

    @JavascriptInterface
    public String wsList() {
        try {
            JSONArray arr = new JSONArray();
            Uri root = rootDocUri();
            if (root == null) return arr.toString();
            String rootId = DocumentsContract.getTreeDocumentId(workspaceUri);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(workspaceUri, rootId);
            try (Cursor c = activity.getContentResolver().query(children,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE},
                    null, null, null)) {
                if (c != null) while (c.moveToNext()) {
                    JSONObject o = new JSONObject();
                    o.put("name", c.getString(0));
                    o.put("dir", DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)));
                    o.put("size", c.isNull(2) ? 0 : c.getLong(2));
                    arr.put(o);
                }
            }
            return arr.toString();
        } catch (Throwable e) { return "[]"; }
    }

    @JavascriptInterface
    public String wsRead(String name) {
        try {
            Uri uri = findInWorkspace(safeName(name));
            if (uri == null) return "工作目录中不存在：" + name;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(
                    activity.getContentResolver().openInputStream(uri), StandardCharsets.UTF_8))) {
                String line; int total = 0;
                while ((line = br.readLine()) != null) {
                    sb.append(line).append('\n'); total += line.length();
                    if (total > 2_000_000) return "文件过大，暂只支持读取 2MB 以内文本";
                }
            }
            return sb.toString();
        } catch (Throwable e) { return "读取失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()); }
    }

    @JavascriptInterface
    public String wsWrite(String name, String content) {
        OutputStream os = null;
        try {
            if (workspaceUri == null) return "还没有选择工作目录";
            String safe = safeName(name);
            String text = content == null ? "" : content;
            Uri root = rootDocUri();
            if (root == null) return "工作目录权限已失效，请重新选择目录";
            Uri existing = findInWorkspace(safe);
            if (existing != null) {
                try { os = activity.getContentResolver().openOutputStream(existing, "wt"); }
                catch (Exception ignored) { os = activity.getContentResolver().openOutputStream(existing, "w"); }
            } else {
                String mime = mimeFor(safe);
                Uri created = DocumentsContract.createDocument(activity.getContentResolver(), root, mime, safe);
                if (created == null) return "创建文件失败：" + safe;
                try { os = activity.getContentResolver().openOutputStream(created, "wt"); }
                catch (Exception ignored) { os = activity.getContentResolver().openOutputStream(created, "w"); }
            }
            if (os == null) return "无法写入：" + safe;
            try (OutputStream out = os) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
            os = null;
            return "已写入工作目录：" + safe + "（" + text.length() + " 字）";
        } catch (Throwable e) {
            return "写入失败：" + (e.getMessage() == null ? e.toString() : e.getMessage());
        } finally {
            if (os != null) try { os.close(); } catch (Exception ignored) {}
        }
    }

    private String mimeFor(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".xml")) return "application/xml";
        if (n.endsWith(".js") || n.endsWith(".ts")) return "text/plain";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".md")) return "text/markdown";
        return "text/plain";
    }

    @JavascriptInterface
    public String wsDelete(String name) {
        try {
            Uri uri = findInWorkspace(safeName(name));
            if (uri == null) return "工作目录中不存在：" + name;
            return DocumentsContract.deleteDocument(activity.getContentResolver(), uri) ? "已删除：" + name : "删除失败：" + name;
        } catch (Exception e) { return "删除失败：" + e.getMessage(); }
    }

    // ---------- persistent state (files, avoids WebView localStorage quota) ----------
    private File stateDir() {
        File d = new File(activity.getFilesDir(), "state");
        if (!d.exists()) d.mkdirs();
        return d;
    }
    private String stateKey(String key) {
        String k = key == null ? "state" : key.replaceAll("[^A-Za-z0-9._-]", "_");
        return k.isEmpty() ? "state" : k;
    }

    @JavascriptInterface
    public String stateRead(String key) {
        try {
            File f = new File(stateDir(), stateKey(key) + ".json");
            if (!f.exists() || f.length() == 0) return "";
            if (f.length() > 24_000_000L) return "";
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Throwable e) { return ""; }
    }

    @JavascriptInterface
    public void stateWrite(String key, String json) {
        try {
            File dir = stateDir();
            File f = new File(dir, stateKey(key) + ".json");
            File tmp = new File(dir, stateKey(key) + ".tmp");
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write((json == null ? "" : json).getBytes(StandardCharsets.UTF_8));
            }
            if (!tmp.renameTo(f)) {
                try (FileOutputStream fos = new FileOutputStream(f)) {
                    fos.write((json == null ? "" : json).getBytes(StandardCharsets.UTF_8));
                }
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
            }
        } catch (Throwable ignored) {}
    }

    // ---------- app files ----------
    private File filesDir() {
        File d = new File(activity.getFilesDir(), "agent_files");
        if (!d.exists()) d.mkdirs();
        return d;
    }
    private String safeName(String name) {
        String n = name == null ? "file.txt" : name.replace("\\", "/");
        if (n.contains("/")) n = n.substring(n.lastIndexOf('/') + 1);
        n = n.replace("..", "_");
        return n.isEmpty() ? "file.txt" : n;
    }

    @JavascriptInterface
    public String writeFile(String name, String content) {
        try {
            File f = new File(filesDir(), safeName(name));
            try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(content.getBytes(StandardCharsets.UTF_8)); }
            return "已写入：" + f.getName() + "（" + f.length() + " 字节）";
        } catch (Exception e) { return "写入失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String readFile(String name) {
        try {
            File f = new File(filesDir(), safeName(name));
            if (!f.exists()) return "文件不存在：" + f.getName();
            if (f.length() > 2_000_000) return "文件过大，暂只支持读取 2MB 以内文本";
            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
                String line; while ((line = br.readLine()) != null) sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Exception e) { return "读取失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String listFiles() {
        try {
            JSONArray arr = new JSONArray();
            File[] fs = filesDir().listFiles();
            if (fs != null) for (File f : fs) {
                JSONObject o = new JSONObject(); o.put("name", f.getName()); o.put("size", f.length()); o.put("dir", f.isDirectory()); arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) { return "[]"; }
    }

    @JavascriptInterface
    public String deleteFile(String name) {
        try {
            File f = new File(filesDir(), safeName(name));
            return f.delete() ? "已删除：" + f.getName() : "删除失败：" + f.getName();
        } catch (Exception e) { return "删除失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String models() {
        try {
            JSONArray arr = new JSONArray();
            File dir = new File(activity.getFilesDir(), "models");
            File[] fs = dir.listFiles();
            if (fs != null) for (File f : fs) if (f.isFile()) {
                JSONObject o = new JSONObject(); o.put("name", f.getName()); o.put("path", f.getAbsolutePath()); o.put("size", f.length()); arr.put(o);
            }
            return arr.toString();
        } catch (Exception e) { return "[]"; }
    }

    // ---------- phone actions ----------
    @JavascriptInterface
    public String openUrl(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
            return "已打开：" + url;
        } catch (Exception e) { return "打开失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String shareText(String text) {
        try {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_TEXT, text);
            activity.startActivity(Intent.createChooser(i, "分享"));
            return "已调起分享";
        } catch (Exception e) { return "分享失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String copyText(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("agent_etc", text));
            return "已复制到剪贴板";
        } catch (Exception e) { return "复制失败：" + e.getMessage(); }
    }

    @JavascriptInterface
    public String pasteText() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence s = cm.getPrimaryClip().getItemAt(0).getText();
                return s == null ? "" : s.toString();
            }
        } catch (Exception ignored) {}
        return "";
    }

    @JavascriptInterface
    public String appVersion() { return "1.6.2"; }
}
