"use client";

import { useEffect } from "react";

export function PWARegistrar() {
  // 未申请持久存储时，浏览器空间紧张可以整库清掉 IndexedDB 里的聊天记录
  useEffect(() => {
    const storage = navigator.storage;
    if (!storage?.persist || !storage.persisted) return;
    storage.persisted()
      .then((persisted) => (persisted ? true : storage.persist()))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
