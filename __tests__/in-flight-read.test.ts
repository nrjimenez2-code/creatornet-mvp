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
