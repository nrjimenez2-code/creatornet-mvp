/** @jest-environment jsdom */
import { connectSoundAccount, readSoundOn, writeSoundOn, SOUND_PREF_KEY, type SoundAccount } from "@/lib/audioPreference";
import { createSoundAccount } from "@/lib/soundAccount";

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let disconnect = () => {};
const bind = (value: SoundAccount | null) => {
  disconnect();
  disconnect = connectSoundAccount(value);
};
beforeEach(() => { localStorage.clear(); bind(null); });
afterEach(() => { disconnect(); });

test("new device waits for account mute, and loading it does not write it back", async () => {
  const load = deferred<boolean>();
  const save = jest.fn();
  bind({ id: "a", load: () => load.promise, save });
  expect(readSoundOn()).toBe(false);
  load.resolve(false);
  await settle();
  expect(readSoundOn()).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

test("new account defaults to sound without recording an explicit choice", async () => {
  const save = jest.fn();
  bind({ id: "a", load: async () => undefined, save });
  await settle();
  expect(readSoundOn()).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

test("existing browser mute migrates only when account preference is absent", async () => {
  localStorage.setItem(SOUND_PREF_KEY, "false");
  const save = jest.fn(async () => {});
  bind({ id: "a", load: async () => undefined, save });
  await settle();
  expect(readSoundOn()).toBe(false);
  expect(save).toHaveBeenCalledWith(false);
  bind({ id: "b", load: async () => true, save });
  await settle();
  expect(readSoundOn()).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
});

test("late account read cannot undo a tap, even if the save already completed", async () => {
  const load = deferred<boolean>();
  const save = jest.fn(async () => {});
  bind({ id: "a", load: () => load.promise, save });
  writeSoundOn(true);
  await settle();
  load.resolve(false);
  await settle();
  expect(readSoundOn()).toBe(true);
  expect(save).toHaveBeenCalledWith(true);
});

test("rapid toggles save serially and finish on the last choice", async () => {
  const first = deferred<void>();
  const save = jest.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  bind({ id: "a", load: async () => undefined, save });
  await settle();
  writeSoundOn(false);
  await settle();
  writeSoundOn(true);
  expect(save).toHaveBeenCalledTimes(1);
  first.resolve();
  await settle();
  expect(save.mock.calls).toEqual([[false], [true]]);
  expect(readSoundOn()).toBe(true);
});

test("failed save survives reconnect and stale account read", async () => {
  const save = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  bind({ id: "a", load: async () => true, save });
  await settle();
  writeSoundOn(false);
  await settle();
  expect(readSoundOn()).toBe(false);
  const stale = deferred<boolean>();
  bind({ id: "a", load: () => stale.promise, save });
  await settle(); // pending local mute saved before stale read arrives
  stale.resolve(true);
  await settle();
  expect(readSoundOn()).toBe(false);
  expect(save.mock.calls).toEqual([[false], [false]]);
});

test("online retries a failed save without changing local sound", async () => {
  const save = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  bind({ id: "a", load: async () => true, save });
  await settle();
  writeSoundOn(false);
  await settle();
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(save.mock.calls).toEqual([[false], [false]]);
  expect(readSoundOn()).toBe(false);
});

test("account switch ignores old reads and saves, and restores guest preference on sign-out", async () => {
  writeSoundOn(false); // guest
  const oldLoad = deferred<boolean>();
  const oldSave = deferred<void>();
  bind({ id: "a", load: () => oldLoad.promise, save: () => oldSave.promise });
  writeSoundOn(false);
  await settle();
  const saveB = jest.fn(async () => {});
  bind({ id: "b", load: async () => true, save: saveB });
  await settle();
  oldLoad.resolve(false);
  oldSave.resolve();
  await settle();
  expect(readSoundOn()).toBe(true);
  expect(saveB).not.toHaveBeenCalled();
  bind(null);
  expect(readSoundOn()).toBe(false);
});

test("token refresh orders new writes after the previous connection's in-flight save", async () => {
  const oldSave = deferred<void>();
  bind({ id: "a", load: async () => true, save: () => oldSave.promise });
  await settle();
  writeSoundOn(false);
  await settle();
  const newSave = jest.fn(async () => {});
  bind({ id: "a", load: async () => true, save: newSave });
  writeSoundOn(true);
  await settle();
  expect(newSave).not.toHaveBeenCalled();
  oldSave.resolve();
  await settle();
  expect(newSave.mock.calls.at(-1)).toEqual([true]);
  expect(readSoundOn()).toBe(true);
});

test("account API saves only the sound field using the captured user's token", async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "a", user_metadata: { cn_sound_on: false } }) });
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const transport = createSoundAccount("a", "test-account-a-token");
    await transport.save(false);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT", headers: { Authorization: "Bearer test-account-a-token" },
      body: JSON.stringify({ data: { cn_sound_on: false } }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "b", user_metadata: { cn_sound_on: true } }) });
    await expect(transport.load()).rejects.toThrow("account mismatch");
    fetchMock.mockResolvedValueOnce({ ok: false });
    await expect(transport.save(true)).rejects.toThrow("sync failed");
  } finally {
    globalThis.fetch = original;
  }
});
