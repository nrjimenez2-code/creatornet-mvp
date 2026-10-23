test("the real SDK signs MIME and length with the one-hour upload lifetime", async () => {
  // Replace the entire environment without reading any configured credential.
  const replacement = jest.replaceProperty(process, "env", {
    NODE_ENV: "test", R2_ACCOUNT_ID: "example", R2_ACCESS_KEY_ID: "FAKE_TEST_ACCESS",
    R2_SECRET_ACCESS_KEY: "FAKE_TEST_SECRET", R2_BUCKET_NAME: "test-bucket", R2_PUBLIC_URL: "https://media.test",
  });
  try {
    const { createPresignedUploadUrl, r2Client } = await import("@/lib/r2");
    const send = jest.spyOn(r2Client, "send");
    const url = new URL(await createPresignedUploadUrl("videos/creator/test.mp4", "video/mp4", 500 * 1024 * 1024));
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-type", "content-length", "host"]));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    r2Client.destroy();
  } finally { replacement.restore(); }
});
