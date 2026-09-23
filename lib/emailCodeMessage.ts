const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character] ?? character);

export function emailCodeMessage(code: string) {
  const safeCode = escapeHtml(code);

  return {
    subject: "Your CreatorNet verification code",
    text: `Your CreatorNet verification code is ${code}.\n\nEnter it on CreatorNet to continue. It expires in 10 minutes and can only be used once.\n\nIf you did not request this code, you can ignore this email. Never share this code.`,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>CreatorNet verification code</title>
  </head>
  <body style="margin:0;padding:0;background:#080808;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;font-size:1px;line-height:1px;color:#080808;max-height:0;max-width:0;opacity:0;overflow:hidden;">Enter your code on CreatorNet. It expires in 10 minutes.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#080808;">
      <tr><td align="center" style="padding:40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px;background:#171717;border:1px solid #343434;border-radius:20px;">
          <tr><td style="padding:32px 32px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="padding-right:10px;vertical-align:middle;"><img src="https://www.creatornet.net/logo.png" width="32" height="32" alt="" style="display:block;border:0;width:32px;height:32px;"></td>
              <td style="vertical-align:middle;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.4px;">CreatorNet</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:36px 32px 32px;">
            <h1 style="margin:0;color:#ffffff;font-size:26px;line-height:1.25;font-weight:700;">Your verification code</h1>
            <p style="margin:14px 0 26px;color:#c9c9d0;font-size:15px;line-height:1.6;">Enter this code on CreatorNet to continue.</p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#242036;border:1px solid #6651ad;border-radius:12px;"><tr>
              <td align="center" style="padding:20px 12px;color:#ffffff;font-size:36px;line-height:1.2;font-weight:700;letter-spacing:7px;font-variant-numeric:tabular-nums;">${safeCode}</td>
            </tr></table>
            <p style="margin:20px 0 0;color:#c9c9d0;font-size:13px;line-height:1.6;">Expires in 10 minutes &middot; One-time use</p>
            <p style="margin:30px 0 0;padding-top:20px;border-top:1px solid #343434;color:#a8a8b0;font-size:12px;line-height:1.6;">If you didn&rsquo;t request this code, you can ignore this email. Never share this code.</p>
          </td></tr>
        </table>
        <p style="margin:18px 0 0;color:#a8a8b0;font-size:12px;line-height:1.5;">CreatorNet &middot; creatornet.net</p>
      </td></tr>
    </table>
  </body>
</html>`,
  };
}
