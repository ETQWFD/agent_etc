package com.etwqfd.agentetc;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

/** 用户主动授权的屏幕读取/点击服务；只读当前可见界面，不绕过验证码或支付确认。 */
public class AgentAccessibilityService extends AccessibilityService {
    private static volatile AgentAccessibilityService instance;
    private static volatile boolean connected = false;

    public static boolean isReady() { return connected && instance != null; }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        connected = true;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {}

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        connected = false;
        instance = null;
        super.onDestroy();
    }

    private static void walk(AccessibilityNodeInfo node, JSONArray out, int depth) {
        if (node == null || depth > 14 || out.length() >= 160) return;
        try {
            String text = node.getText() == null ? "" : node.getText().toString();
            String desc = node.getContentDescription() == null ? "" : node.getContentDescription().toString();
            if (!text.isEmpty() || !desc.isEmpty() || node.isClickable()) {
                JSONObject o = new JSONObject();
                o.put("text", text);
                o.put("desc", desc);
                o.put("cls", node.getClassName() == null ? "" : node.getClassName().toString());
                o.put("clickable", node.isClickable());
                Rect r = new Rect();
                node.getBoundsInScreen(r);
                o.put("bounds", new JSONArray(new int[]{r.left, r.top, r.right, r.bottom}));
                out.put(o);
            }
            for (int i = 0; i < node.getChildCount(); i++) walk(node.getChild(i), out, depth + 1);
        } catch (Exception ignored) {}
    }

    public static String dumpScreen() {
        if (!isReady()) return "{\"enabled\":false,\"error\":\"无障碍服务未开启\"}";
        try {
            AccessibilityNodeInfo root = instance.getRootInActiveWindow();
            if (root == null) return "{\"enabled\":true,\"error\":\"当前没有可读取的窗口\"}";
            JSONObject out = new JSONObject();
            out.put("enabled", true);
            out.put("package", root.getPackageName() == null ? "" : root.getPackageName().toString());
            JSONArray nodes = new JSONArray();
            walk(root, nodes, 0);
            out.put("nodes", nodes);
            return out.toString();
        } catch (Exception e) {
            return "{\"enabled\":true,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
        }
    }

    public static String tap(int x, int y) {
        if (!isReady()) return "无障碍服务未开启，请先在系统设置里授权";
        if (Build.VERSION.SDK_INT < 24) return "当前 Android 版本不支持手势点击";
        try {
            Path path = new Path();
            path.moveTo(x, y);
            GestureDescription.StrokeDescription stroke = new GestureDescription.StrokeDescription(path, 0, 80);
            boolean ok = instance.dispatchGesture(new GestureDescription.Builder().addStroke(stroke).build(), null, null);
            return ok ? ("已点击 " + x + "," + y) : "点击未执行（可能被系统拦截）";
        } catch (Exception e) {
            return "点击失败：" + e.getMessage();
        }
    }

    public static String back() {
        if (!isReady()) return "无障碍服务未开启";
        return instance.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK) ? "已返回" : "返回失败";
    }
}
