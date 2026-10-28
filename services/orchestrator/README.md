# services/orchestrator

Python service on the instabox VM: claims jobs from Convex, acquires one Modal sandbox per job, watches heartbeat, always terminates the sandbox in a finally path, retries with resume, and runs the sweeper. Stub only. Built by T1.11. Spec: SPEC.md §11.
