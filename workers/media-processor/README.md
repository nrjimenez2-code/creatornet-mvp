# Public video processor

Source for the deployed creatornet-video-processor Worker. R2 videos/ create events feed the creatornet-video-processing queue. Private state prevents duplicate imports; completed MP4 copies are served through media.creatornet.net. Originals remain available while encoding or on failure.

Run node --test workers/media-processor/worker.test.mjs. Deploy separately with the reviewed Wrangler configuration; normal application deployments do not redeploy the Worker. Stream copies currently remain stored and count toward the subscribed capacity. No credentials are included.
