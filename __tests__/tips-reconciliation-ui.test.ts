/** @jest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TipReconciliationControl } from "../app/admin/commerce/TipReconciliationControl";

const fetchMock = jest.fn();
const onComplete = jest.fn();
let container: HTMLDivElement, root: Root;
const button = (label: string) => Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label)!;
const checkbox = () => container.querySelector('input[type="checkbox"]') as HTMLInputElement;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = fetchMock;
  fetchMock.mockReset(); onComplete.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(TipReconciliationControl, { onComplete })));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function review() { await act(async () => button("Review tip reconciliation").click()); }
async function confirm() { await act(async () => checkbox().click()); }

test("opening a review never starts a request and explains the recovery scope", async () => {
  await review();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(button("Run reconciliation").disabled).toBe(true);
  expect(container.textContent).toContain("retry transfers");
  expect(container.textContent).toContain("Search filters do not limit reconciliation");
});

test("each batch requires explicit confirmation and only uses the returned cursor", async () => {
  await review(); await confirm();
  fetchMock.mockResolvedValueOnce(response({ reconciledCount: 1, skippedCount: 0, failureCount: 0, nextCursor: "server-cursor" }))
    .mockResolvedValueOnce(response({ reconciledCount: 0, skippedCount: 0, failureCount: 0, nextCursor: null }));
  await act(async () => button("Run reconciliation").click());
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ limit: 1 });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/tips/reconcile");
  expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(button("Run next batch").disabled).toBe(true);
  await confirm(); await act(async () => button("Run next batch").click());
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ limit: 1, cursor: "server-cursor" });
  expect(onComplete).toHaveBeenCalledTimes(2);
});

test("a pending request cannot be submitted twice or closed", async () => {
  await review(); await confirm();
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  await act(async () => { button("Run reconciliation").click(); button("Run reconciliation").click(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(button("Close reconciliation review").disabled).toBe(true);
  expect(checkbox().disabled).toBe(true);
  await act(async () => finish(response({ reconciledCount: 1, skippedCount: 0, failureCount: 0, nextCursor: null })));
});

test.each(["lost", "http", "malformed"])("%s response holds further runs without claiming success", async (kind) => {
  await review(); await confirm();
  if (kind === "lost") fetchMock.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"));
  else fetchMock.mockResolvedValueOnce(response(kind === "http" ? { error: "PRIVATE_PROVIDER_DETAIL" } : { reconciledCount: 1 }, kind !== "http"));
  await act(async () => button("Run reconciliation").click());
  expect(container.textContent).toContain("Some updates may have completed");
  expect(container.textContent).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(onComplete).not.toHaveBeenCalled();
  expect(button("Run reconciliation").disabled).toBe(true);
  await act(async () => button("Close reconciliation review").click()); await review();
  expect(button("Run reconciliation").disabled).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("reported failures remain visible instead of being described as a clean run", async () => {
  await review(); await confirm();
  fetchMock.mockResolvedValueOnce(response({ reconciledCount: 0, skippedCount: 1, failureCount: 2, nextCursor: null }));
  await act(async () => button("Run reconciliation").click());
  expect(container.textContent).toContain("0 reconciled, 1 skipped, 2 failures");
  expect(container.textContent).toContain("Review failed tip and recovery records");
  expect(checkbox().checked).toBe(false);
});

test("invalid batch size cannot dispatch a request", async () => {
  await review();
  const input = container.querySelector('input[type="number"]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const value of ["0", "51", "1.5", ""]) {
    await act(async () => { setValue.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
    if (!checkbox().checked) await confirm();
    expect(button("Run reconciliation").disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  }
});
