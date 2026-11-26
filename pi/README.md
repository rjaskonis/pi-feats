# Pi Agent deployment

This directory is the source of truth for the custom Pi Agent images and their Docker Compose/Dokploy deployment. Maintain the images and deployment files here in `pi-feats`, not in `ai-agents-assets`. The Docker setup is optional; regular Pi installations use the [package installation workflow](../README.md#installation).

| Path | Purpose |
| --- | --- |
| `base/Dockerfile` | Builds `pi-agent-core` with Pi, Nono, and OS utilities, including `mariadb` and `psql`. |
| `base/publish.sh` | Builds and pushes the base image to the configured registry. |
| `Dockerfile` | Builds the final Pi Agent image from `pi-agent-core` and bundles the `pi-feats` package, including the API Server and Console. |
| `docker-compose.yml` | Defines the service, persistent mount, health check, and Traefik routes for Compose or Dokploy. |
| `docker-entrypoint.sh`, `start-pi-services.sh` | Initialize or migrate persisted state and start the bundled services. |

## Publish the base image

From `pi/`, create `base/.env` from `base/.env.example` if it does not already exist. Set the registry, repository, username and password. The final Dockerfile currently expects `docker.alphanexus.cloud/alphanexus/pi-agent-core:latest`.

```bash
./base/publish.sh
```

This script authenticates with the registry and publishes the base image with both `latest` and a date tag. Publishing does not rebuild the final image or restart any container.

## Build and deploy the final image

1. From `pi/`, copy `.env.compose.example` to `.env` if it does not exist. Set deployment credentials, host names, and a production `PI_FEATS_REF` (a tag or commit SHA already available from `PI_FEATS_REPOSITORY`). The build clones that ref; it does not use uncommitted extension changes from the deployment checkout.
2. Authenticate Docker to the private base registry with pull access. In Dokploy, point the Compose deployment at `pi/docker-compose.yml` and set the corresponding environment and registry credentials there.
3. For a Compose deployment, build and start the service:

   ```bash
   docker compose build --pull pi
   docker compose up -d pi
   ```

Use these same commands after publishing an updated base image. `--pull` ensures that the build checks for the current base tag.

The first startup seeds the image's version of `pi-feats` into the persistent package-manager directory:

```text
/root/.pi/agent/git/github.com/rjaskonis/pi-feats
```

It registers the package in `/root/.pi/agent/settings.json`. Compose mounts `PI_DATA_PATH` (default: `./data`) at `/root/.pi`. Profiles, sessions, credentials, Applications and other runtime state stay in that mount and are not part of the image. Keep the same mount when recreating a deployment, or choose a fresh path for an isolated test instance. Never commit `.env`, `base/.env`, or `data/`.

## Update and rollback

The image installs the latest published Pi CLI in `/usr/local/bin/pi` at build time. This path works in login shells and is not shadowed by the persistent `/root/.pi` mount. Existing runtime files in that mount are left untouched. Rebuild and redeploy to update the CLI; startup does not download it. Set `PI_CLI_VERSION` to pin or roll back the CLI version. Compose disables build-layer caching by default so the `latest` tag is resolved again; set `PI_BUILD_NO_CACHE=false` if you explicitly want to reuse cached layers.

Set `PI_FEATS_REF` to the intended commit or tag before building. This controls the bundled package and the startup registration. The entrypoint seeds the bundled checkout only if no package is present in the mount. Rebuilding the image or changing the ref does not replace an existing mounted checkout. For an existing deployment, update or restore the mounted checkout separately and verify its version in the running container. To update an unpinned package manually, use:

```bash
pi update --extensions
```

To roll back, redeploy the previous image and restore the matching mounted package checkout if it changed. Keep the rest of the runtime state in the mount.

On migration from old images, the former `/root/.pi/agent/extensions` directory is preserved at `/root/.pi/agent/legacy-root/extensions` so the same extensions cannot be loaded both as local files and as a package.
