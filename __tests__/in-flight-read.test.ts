import {inFlightRead} from '@/lib/inFlightRead';
test('overlapping identical reads share work; later requests read fresh data', async () => {
 const share = inFlightRead<number>();
 let resolve!: (value: number) => void;
 const first = jest.fn(() => new Promise<number>(done => {resolve=done;}));
 const requests = Array.from({length:100}, () => share('same', first));
 await Promise.resolve();
 expect(first).toHaveBeenCalledTimes(1);
 resolve(1);
 expect(await Promise.all(requests)).toEqual(Array(100).fill(1));
 expect(await share('same', async () => 2)).toBe(2);
});
test('different keys cannot share results', async () => {
 const share=inFlightRead<string>();
 expect(await Promise.all([share('a',async()=>'a'),share('b',async()=>'b')])).toEqual(['a','b']);
});
test('a failed read is removed so recovery can succeed', async () => {
 const share=inFlightRead<number>();
 await expect(share('same',async()=>{throw new Error('temporary');})).rejects.toThrow('temporary');
 await expect(share('same',async()=>3)).resolves.toBe(3);
});

test('join observation retains the exact shared promise and observer errors cannot change it', async () => {
 const share = inFlightRead<number>();
 const ownerObserver = jest.fn();
 const first = share('same', async () => 5, ownerObserver);
 const joiningObserver = jest.fn(() => { throw new Error('diagnostics failed'); });
 expect(share('same', async () => 99, joiningObserver)).toBe(first);
 expect(ownerObserver).not.toHaveBeenCalled();
 expect(joiningObserver).toHaveBeenCalledTimes(1);
 expect(await first).toBe(5);
 expect(await share('same', async () => 6, ownerObserver)).toBe(6);
 expect(ownerObserver).not.toHaveBeenCalled();
});
