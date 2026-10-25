test("bodyless presigns preserve the upload contract without an empty-payload checksum", async () => {
  // Replace the entire environment without reading any configured credential.
  const replacement = jest.replaceProperty(process, "env", {
    NODE_ENV: "test", R2_ACCOUNT_ID: "example", R2_ACCESS_KEY_ID: "FAKE_TEST_ACCESS",
    R2_SECRET_ACCESS_KEY: "FAKE_TEST_SECRET", R2_BUCKET_NAME: "test-bucket", R2_PUBLIC_URL: "https://media.test",
    AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_SUPPORTED",
  });
  try {
    const { createPresignedUploadUrl, r2Client } = await import("@/lib/r2");
    const send = jest.spyOn(r2Client, "send");
    for (const [key, mime, size] of [
      ["videos/creator/test.mp4", "video/mp4", 500 * 1024 * 1024],
      ["thumbnails/creator/test.png", "image/png", 74],
    ] as const) {
      const url = new URL(await createPresignedUploadUrl(key, mime, size));
      expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-type", "content-length", "if-none-match", "host"]));
      expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
      // The browser supplies the bytes later. A bodyless presign must not bind
      // that future upload to CRC32(empty), which does not match either file.
      expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
      expect(url.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
    }
    // Server uploads still use the normal integrity checks when they have bytes.
    expect(await r2Client.config.requestChecksumCalculation()).toBe("WHEN_SUPPORTED");
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    r2Client.destroy();
  } finally { replacement.restore(); }
});
