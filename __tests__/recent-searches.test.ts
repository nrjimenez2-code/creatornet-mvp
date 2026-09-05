/** @jest-environment jsdom */
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { readRecentSearches, recentSearchesServerSnapshot, parseRecentSearches, saveRecentSearches, subscribeRecentSearches } from "@/lib/recentSearches";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => localStorage.clear());
afterEach(() => jest.restoreAllMocks());

test("invalid storage is rejected, entries are strings, history is capped at ten", () => {
  expect(parseRecentSearches("broken")).toEqual([]);
  expect(parseRecentSearches('{"x":1}')).toEqual([]);
  expect(parseRecentSearches('["ecom",3,null,"sales"]')).toEqual(["ecom", "sales"]);
  saveRecentSearches(Array.from({ length: 12 }, (_, i) => String(i)));
  expect(parseRecentSearches(readRecentSearches())).toHaveLength(10);
  expect(recentSearchesServerSnapshot()).toBe("[]");
});

test("storage events only refresh the relevant key, and unsubscribe removes listeners", () => {
  const changed = jest.fn();
  const unsubscribe = subscribeRecentSearches(changed);
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
  expect(changed).not.toHaveBeenCalled();
  window.dispatchEvent(new StorageEvent("storage", { key: "recent-searches" }));
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
  saveRecentSearches(["ecom"]);
  expect(changed).toHaveBeenCalledTimes(2);
});

test("denied storage cannot break search", () => {
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
  expect(readRecentSearches()).toBe("[]");
  expect(() => saveRecentSearches(["ecom"])).not.toThrow();
});

test("a mounted consumer reads saved history and reacts to same-tab writes", async () => {
  localStorage.setItem("recent-searches", '["old"]');
  const container = document.createElement("div");
  const root = createRoot(container);
  function History() {
    const value = useSyncExternalStore(subscribeRecentSearches, readRecentSearches, recentSearchesServerSnapshot);
    return createElement("p", null, parseRecentSearches(value).join(","));
  }
  try {
    await act(async () => root.render(createElement(History)));
    expect(container.textContent).toBe("old");
    await act(async () => saveRecentSearches(["new", "old"]));
    expect(container.textContent).toBe("new,old");
  } finally {
    await act(async () => root.unmount());
  }
});
