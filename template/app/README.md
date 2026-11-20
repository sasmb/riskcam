# RiskCam

Built with [Wasp](https://wasp.sh), based on the [Open Saas](https://opensaas.sh) template.

This local RiskCam fork pins Wasp `^0.26.0` and Prisma `5.19.1` to match the
stable Wasp CLI available for this task. The upstream template currently uses
newer versions; keep these pins aligned with the CLI when developing this fork.

## Development

### Running locally

- Make sure you have the `.env.client` and `.env.server` files with correct dev values in the root of the project.
- Set `VLM_WORKER_URL=http://localhost:8000` and a shared `VLM_WORKER_SECRET` in `.env.server`; the Python worker uses the same secret.
- Set `TYPESAFE_API_KEY` before submitting scans so the server can request a Jev screening decision.
- Run the database with `wasp start db` and leave it running.
- Run `wasp start` and leave it running.
- [OPTIONAL]: If this is the first time starting the app, or you've just made changes to your entities/prisma schema, also run `wasp db migrate-dev`.
