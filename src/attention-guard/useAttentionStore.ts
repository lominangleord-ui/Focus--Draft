import { useCallback, useEffect, useRef, useState } from "react";
import { loadAttentionStore, normalizeAttentionStore, saveAttentionStore, type AttentionStore } from "./storage";

export function useAttentionStore() {
  const [store, setStore] = useState<AttentionStore>(loadAttentionStore);
  const storeRef = useRef(store);
  storeRef.current = store;

  const updateStore = useCallback((update: Partial<AttentionStore> | ((previous: AttentionStore) => AttentionStore)) => {
    setStore((previous) => normalizeAttentionStore(
      typeof update === "function" ? update(previous) : { ...previous, ...update },
    ));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => { saveAttentionStore(store); }, 350);
    return () => window.clearTimeout(id);
  }, [store]);

  useEffect(() => {
    const flush = () => { saveAttentionStore(storeRef.current); };
    const onVisibility = () => { if (document.hidden) flush(); };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { store, updateStore };
}
