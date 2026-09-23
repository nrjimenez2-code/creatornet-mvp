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
<body style="margin:0;background:#f8f5ff;font-family:Arial,Helvetica,sans-serif;color:#18181b;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border:1px solid #ece7f6;border-radius:18px;"><tr><td style="padding:36px;text-align:center;">
<div style="font-size:24px;font-weight:800;letter-spacing:.08em;">CREATORNET</div>
<p style="color:#9370db;font-size:14px;font-weight:700;">Scroll, Learn, Earn.</p>
<h1 style="font-size:24px;">Your sign-in code</h1>
<p style="color:#62606a;font-size:15px;line-height:1.6;">Enter this six-digit code on CreatorNet to continue.</p>
<div style="margin:24px auto 16px;padding:16px 20px;background:#f5f0ff;border:1px solid #ded2f7;border-radius:12px;color:#5f45a8;font-size:32px;font-weight:800;letter-spacing:.22em;">${safeCode}</div>
<p style="color:#77737f;font-size:13px;line-height:1.5;">This code expires in 10 minutes and can only be used once.</p>
<p style="margin-top:28px;color:#908b98;font-size:12px;line-height:1.6;">If you did not request this email, you can safely ignore it. CreatorNet will never ask you to share this code.</p>
</td></tr></table>
<p style="color:#9994a2;font-size:11px;">CreatorNet · support@creatornet.net</p>
</td></tr></table>
</body>
</html>`,
  };
}
