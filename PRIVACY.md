# Privacy and telemetry

This deployment does not enable Google Analytics. The inherited compiled bundle still contains an old analytics integration, but the local server and Vercel configuration block it with Content Security Policy.

Online play uses WebRTC signalling and relay services through Trystero. Participants' network metadata is therefore processed by the selected relay/TURN providers. Before enabling online play publicly, publish the chosen providers and their privacy terms.

Do not remove the CSP restriction for Google Tag Manager until a project-owned analytics property, consent UI, and privacy notice have been reviewed.
