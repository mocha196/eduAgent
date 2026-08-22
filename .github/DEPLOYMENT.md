# CI/CD deployment setup

The `CI/CD` workflow validates both applications on pull requests. Pushes to
`main` or `master` publish immutable SHA tags and `latest` tags to GHCR. The
production deployment job runs only when the repository variable
`DEPLOY_ENABLED` is set to `true`.

## Production environment configuration

Create a GitHub Environment named `production`, add protection rules if
desired, and configure these secrets:

- `DEPLOY_HOST`: production server hostname or IP.
- `DEPLOY_USER`: SSH user with Docker access.
- `DEPLOY_SSH_KEY`: private SSH key for that user.
- `DEPLOY_KNOWN_HOSTS`: pinned `known_hosts` entry for the server.
- `GHCR_USERNAME`: GitHub account used by the server to pull images.
- `GHCR_PULL_TOKEN`: fine-grained token with read access to both container images.

Configure these repository or environment variables:

- `DEPLOY_ENABLED`: set to `true` only after the server is prepared.
- `DEPLOY_PORT`: optional SSH port, default `22`.
- `DEPLOY_PATH`: optional deployment directory, default `/opt/edu-platform`.

The server must already have Docker with Compose v2 and a production `.env` at
`DEPLOY_PATH/.env`. Never commit that file. The workflow copies only the Compose
manifest, logs in to GHCR, pulls the published images, applies database
migrations through the Next.js container startup command, restarts the stack,
and checks both the RAG and Next.js health endpoints. Production runs immutable
`sha-<commit>` image tags rather than relying on a mutable `latest` deployment.
