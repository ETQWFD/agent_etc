package com.etwqfd.agentetc;

public final class LlamaBridge {
    static {
        System.loadLibrary("agentllama");
    }
    private static long handle = 0;
    private static final Object LOCK = new Object();

    public static native void nativeInit();
    public static native String nativeLastError();
    public static native long nativeLoad(String path, int nCtx, int threads, int gpu);
    public static native void nativeFree(long h);
    public static native String nativeBuildPrompt(long h, String[] roles, String[] contents);
    public static native String nativeGenerate(long h, String prompt, int maxTokens, float temp, float topP, int topK);
    public static native String nativeInfo(long h);

    public static synchronized boolean load(String path, int nCtx, int threads, int gpu) {
        nativeInit();
        if (handle != 0) { nativeFree(handle); handle = 0; }
        handle = nativeLoad(path, nCtx, threads, gpu);
        return handle != 0;
    }

    public static synchronized void unload() {
        if (handle != 0) { nativeFree(handle); handle = 0; }
    }

    public static synchronized boolean ready() { return handle != 0; }
    public static synchronized long getHandle() { return handle; }
    public static synchronized String lastError() { return nativeLastError(); }
}
