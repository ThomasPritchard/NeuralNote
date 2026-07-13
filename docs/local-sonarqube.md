# Local SonarQube

NeuralNote uses SonarQube as a local maintainer quality gate. GitHub Actions does
not connect to this service, and external contributors do not need a SonarQube
token to open a pull request.

The repository Compose file runs SonarQube Community Build on the loopback
interface only. It uses the embedded database and named Docker volumes. This is
appropriate for one developer's local analysis, not for a shared or production
SonarQube deployment.

## Prerequisites

Install:

- Docker Desktop or another Docker engine with Compose support
- SonarScanner CLI 8 or later
- the frontend and Rust coverage tools described in
  [CONTRIBUTING.md](../CONTRIBUTING.md)

Confirm the tools without starting a service:

```bash
docker compose version
sonar-scanner --version
```

## Start SonarQube

From the repository root:

```bash
docker compose -f compose.sonar.yml up -d
```

The first startup can take several minutes. Wait for the system API to report
`UP`:

```bash
until curl --fail --silent http://localhost:9000/api/system/status \
  | grep --quiet '"status":"UP"'; do
  sleep 5
done
```

If port 9000 is already in use, stop the other local service before retrying.
Do not change the Compose port to a public interface.

## Complete the first-run setup

1. Open <http://localhost:9000>.
2. Sign in with the initial username `admin` and password `admin`.
3. Change the default password immediately.
4. Create a local project with project key `NeuralNote`.
5. Create a project analysis token with no wider permissions than required.
6. Prepare the untracked environment file:

```bash
cp -n .env.sonar.example .env.sonar
chmod 600 .env.sonar
```

Open `.env.sonar` in a local editor and add the token after `SONAR_TOKEN=`. Never
print, echo, paste into chat, or commit the token. The real file is ignored by
Git; only `.env.sonar.example` is tracked.

## Generate coverage and run analysis

Generate the reports referenced by `sonar-project.properties`:

```bash
npm --prefix app/desktop run coverage
cargo llvm-cov -p neuralnote-core --lcov --output-path lcov-rust.info
```

Load the local settings without displaying them, then run the scanner from the
repository root:

```bash
set -a
source .env.sonar
set +a
sonar-scanner -Dsonar.qualitygate.wait=true
```

The wait flag makes a failed quality gate fail the scanner command. Inspect the
local project at <http://localhost:9000/dashboard?id=NeuralNote> for issue and
coverage details.

## Interpret the result

- **Passed:** the scanner completed and reported that the quality gate passed.
- **Failed:** the scanner returned an analysis error or the quality gate failed.
- **Unavailable:** Docker, SonarScanner, `.env.sonar`, or the local server was
  absent or unreachable.

Unavailable is not passed. Report the missing prerequisite or unavailable
service explicitly. External contributors may mark this maintainer-only gate as
not applicable.

## Stop, restart, or reset

Stop SonarQube while keeping its local data:

```bash
docker compose -f compose.sonar.yml stop
```

Start the existing instance again:

```bash
docker compose -f compose.sonar.yml start
```

Remove the container but keep the named volumes:

```bash
docker compose -f compose.sonar.yml down
```

The following reset is destructive. It deletes the local project, analysis
history, users, and tokens stored in the Compose volumes:

```bash
docker compose -f compose.sonar.yml down --volumes
```

Do not reset the volumes without the owner's explicit approval.

## Troubleshooting

Inspect service state and recent logs without exposing `.env.sonar`:

```bash
docker compose -f compose.sonar.yml ps
docker compose -f compose.sonar.yml logs --tail=100 sonarqube
```

Common causes of an unavailable scan are:

- SonarQube is still starting and the status is not yet `UP`.
- Another process owns port 9000.
- `.env.sonar` is absent, unreadable, or has an empty token.
- The token belongs to a different project or was revoked.
- One or both LCOV reports were not generated before scanning.
- Docker does not have enough memory available for SonarQube.

Never attach `.env.sonar`, scanner logs containing credentials, vault content,
or private source-analysis artifacts to a public issue.
