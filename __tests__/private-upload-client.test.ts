import { uploadTusFile, PREMIUM_TUS_CHUNK } from "@/lib/privateUploadClient";
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
function head(offset:number,size:number){return new Response(null,{status:200,headers:{"Upload-Offset":String(offset),"Upload-Length":String(size)}});}
test("resumes committed TUS offset and sends bounded chunks with no cookies",async()=>{
 const file=new File([new Uint8Array(PREMIUM_TUS_CHUNK*2+100)],"long.mp4"),progress=jest.fn();
 globalThis.fetch=jest.fn().mockResolvedValueOnce(head(PREMIUM_TUS_CHUNK,file.size))
  .mockResolvedValueOnce(new Response(null,{status:204,headers:{"Upload-Offset":String(PREMIUM_TUS_CHUNK*2)}}))
  .mockResolvedValueOnce(head(PREMIUM_TUS_CHUNK*2,file.size))
  .mockResolvedValueOnce(new Response(null,{status:204,headers:{"Upload-Offset":String(file.size)}}));
 await uploadTusFile(file,"https://upload.invalid/tus",new AbortController().signal,progress);
 const calls=(fetch as jest.Mock).mock.calls;
 expect(calls.map(c=>c[1].method)).toEqual(["HEAD","PATCH","HEAD","PATCH"]);
 expect(calls[1][1].headers["Upload-Offset"]).toBe(String(PREMIUM_TUS_CHUNK));
 expect(calls[1][1].body.size).toBe(PREMIUM_TUS_CHUNK);expect(calls[3][1].body.size).toBe(100);
 expect(calls.every(c=>c[1].credentials==="omit")).toBe(true);expect(progress).toHaveBeenLastCalledWith(100);
});
test("a finished upload is recovered without sending the file again",async()=>{
 const file=new File(["done"],"video.mp4");globalThis.fetch=jest.fn().mockResolvedValue(head(file.size,file.size));
 await uploadTusFile(file,"https://upload.invalid/tus",new AbortController().signal,jest.fn());
 expect(fetch).toHaveBeenCalledTimes(1);
});
test.each([404,410])("expired upload (%s) never creates a replacement",async status=>{
 globalThis.fetch=jest.fn().mockResolvedValue(new Response(null,{status}));
 await expect(uploadTusFile(new File(["video"],"video.mp4"),"https://upload.invalid/tus",new AbortController().signal,jest.fn())).rejects.toThrow(/expired/);
 expect(fetch).toHaveBeenCalledTimes(1);
});
test("wrong file length fails without a PATCH",async()=>{
 globalThis.fetch=jest.fn().mockResolvedValue(head(0,999));
 await expect(uploadTusFile(new File(["video"],"video.mp4"),"https://upload.invalid/tus",new AbortController().signal,jest.fn())).rejects.toThrow(/original file/);
 expect(fetch).toHaveBeenCalledTimes(1);
});
test("pause ends before any provider request",async()=>{
 globalThis.fetch=jest.fn();const controller=new AbortController();controller.abort();
 await expect(uploadTusFile(new File(["video"],"video.mp4"),"https://upload.invalid/tus",controller.signal,jest.fn())).rejects.toThrow(/paused/);
 expect(fetch).not.toHaveBeenCalled();
});
