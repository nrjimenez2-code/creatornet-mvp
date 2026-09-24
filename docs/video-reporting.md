# Video reporting rollout

Viewer reports are separate from Discover's `not_interested` event. Reports are
stored in `public.post_reports`, which is readable and writable only through
service-role server routes. The admin Content page lists reports by report time,
including reports about posts outside its newest-500-video table.

## Email configuration

Set `REPORT_NOTIFICATION_EMAIL` to the moderation inbox in each deployed
environment where report alerts should be delivered. The sender uses the
existing server-only `RESEND_API_KEY` and `EMAIL_CODE_FROM` configuration. No
recipient address is hard-coded. The review link uses `getSiteUrl()`.

Submission saves the report before attempting email. A missing or failed email
configuration marks the alert `failed` but does not reject the saved report.
Admins see the failure on the Content page and can retry delivery there.

## Database and moderation

The additive `video_reports` migration was applied to staging and production
on 2026-09-24 UTC. Both were verified with RLS enabled, no `anon` or
`authenticated` SELECT privilege, and service-role INSERT access. The table
permits only one *open* report for each reporter/video pair. Admins may mark a
report reviewed or dismissed; neither action automatically changes the post.

Existing Hide, Remove, and Ban actions are reused. Remove still removes a post
from public surfaces while keeping prior buyers' access and stored media. This
feature does not implement a full takedown or media purge.
