import type { SupabaseClient } from "@supabase/supabase-js";
import type { UploadPurpose } from "./uploadTrackingProtocol";

type Progress = (loaded: number, total: number) => void;
type Result = { attemptId: string; key: string; publicUrl: string | null };
type Capability = { provider: "r2"; uploadUrl: string } |
  { provider: "supabase"; token: string; key: string; bucket: string };
type Admission = Result & { capability: Capability };
type Options = {
  ownerId: string; purpose: UploadPurpose; file: Blob; filename: string;
  contentType: string; supabase?: SupabaseClient; onProgress?: Progress;
};

export class TrackedUploadConflict extends Error {}

/** Progress watchdog measures inactivity, preserving slow but advancing uploads. */
export function putTrackedFile(url: string, file: Blob, contentType: string, progress?: Progress): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { xhr.abort(); finish(new Error("Upload stalled. Please try again.")); }, 30_000); };
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.setRequestHeader("If-None-Match", "*");
    // The browser supplies Content-Length for the Blob body.
    xhr.upload.onprogress = event => { arm(); if (event.lengthComputable) progress?.(event.loaded, event.total); };
    xhr.onload = () => finish(xhr.status === 412 ? new TrackedUploadConflict("The original upload needs verification.") :
      xhr.status >= 200 && xhr.status < 300 ? undefined : new Error("The file upload failed. Please try again."));
    xhr.onerror = () => finish(new Error("The upload connection failed. Please try again."));
    xhr.onabort = () => finish(new Error("The upload was interrupted. Please try again."));
    arm(); xhr.send(file);
  });
}

export function createTrackedUploader(deps: {
  request: typeof fetch;
  put: typeof putTrackedFile;
  id: () => string;
  wait: (ms: number) => Promise<void>;
}) {
  // Only non-secret reconciliation metadata survives the PUT. A retry after a
  // verification failure checks the same object instead of uploading it again.
  const uploaded = new WeakMap<Blob, Map<string, Result>>();
  const active = new WeakMap<Blob, Map<string, Promise<Result>>>();
  async function report(attemptId: string, outcome: string) {
    return deps.request(`/api/upload/${attemptId}/complete`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }), cache: "no-store",
    });
  }
  async function verify(result: Result): Promise<Result> {
    for (let n = 0; n < 3; n++) {
      let response: Response | null = null;
      try { response = await report(result.attemptId, "uploaded"); } catch { /* retry reconciliation only */ }
      const data = await response?.json().catch(() => null);
      if (response?.ok && response.status === 200 && data?.objectObserved === true && data?.key === result.key) return result;
      if (response?.status === 409 || response?.status === 401 || response?.status === 404) {
        throw new Error(data?.error || "The uploaded file could not be verified. Please refresh and try again.");
      }
      if (n < 2) await deps.wait(500 * (n + 1));
    }
    throw new Error("Your file was sent, but verification is still pending. Try again to check it without uploading it again.");
  }
  async function run(options: Options, cacheKey: string): Promise<Result> {
    const previous = uploaded.get(options.file)?.get(cacheKey);
    if (previous) return verify(previous);
    const operationId = deps.id();
    const attempts = options.purpose === "video" || options.purpose === "thumbnail" ? 3 : 1;
    for (let n = 0; n < attempts; n++) {
      const response = await deps.request("/api/upload/admit", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ purpose: options.purpose, filename: options.filename,
          contentType: options.contentType, size: options.file.size, operationId, attemptId: deps.id(), uploadContract: "create-only-v1" }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Upload authorization is unavailable. Please try again later.");
      const admission = data as Admission;
      if (!admission?.attemptId || !admission.key || !admission.capability ||
          !["r2", "supabase"].includes(admission.capability.provider)) throw new Error("Upload authorization is unavailable.");
      const result = { attemptId: admission.attemptId, key: admission.key, publicUrl: admission.publicUrl };
      const remember = () => {
        const entries = uploaded.get(options.file) ?? new Map<string, Result>();
        entries.set(cacheKey, result); uploaded.set(options.file, entries);
      };
      try {
        const capability = admission.capability;
        if (capability.provider === "r2") {
          if (!capability.uploadUrl || !admission.publicUrl || !["video", "thumbnail"].includes(options.purpose)) throw new Error("Invalid upload authorization.");
          await deps.put(capability.uploadUrl, options.file, options.contentType, options.onProgress);
        } else {
          const bucket = options.purpose === "avatar" ? "avatars" : "premium";
          if (!options.supabase || capability.bucket !== bucket || capability.key !== admission.key || !capability.token) throw new Error("Invalid upload authorization.");
          const { error } = await options.supabase.storage.from(bucket).uploadToSignedUrl(
            capability.key, capability.token, options.file,
            { contentType: options.contentType, cacheControl: "3600", upsert: false },
          );
          if (error) throw new Error("The file upload failed. Please try again.");
        }
      } catch (error) {
        if (error instanceof TrackedUploadConflict) {
          // A conditional conflict reconciles this exact attempt, even while paused.
          // Retain nonsecret metadata if verification is temporarily unavailable.
          remember();
          return verify(result);
        }
        // A browser error is not proof that the provider stopped writing.
        await report(admission.attemptId, "failed").catch(() => undefined);
        if (n + 1 < attempts) { await deps.wait((n + 1) * 1000); continue; }
        throw new Error("The file upload failed. Please try again.");
      }
      remember();
      return verify(result);
    }
    throw new Error("The file upload failed. Please try again.");
  }
  return function upload(options: Options): Promise<Result> {
    const key = `${options.ownerId.toLowerCase()}:${options.purpose}`;
    const entries = active.get(options.file) ?? new Map<string, Promise<Result>>();
    const existing = entries.get(key);
    if (existing) return existing;
    const promise = run({ ...options, contentType: options.contentType.trim().toLowerCase() }, key).finally(() => entries.delete(key));
    entries.set(key, promise); active.set(options.file, entries);
    return promise;
  };
}

export const uploadTrackedFile = createTrackedUploader({
  request: (...args) => fetch(...args), put: putTrackedFile,
  id: () => crypto.randomUUID(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
});
