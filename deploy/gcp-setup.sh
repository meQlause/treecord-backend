#!/usr/bin/env bash
# One-off Google Cloud setup for the backend's CI/CD (API, worker, migrations). Run it once, as an Owner:
#
#   gcloud auth login
#   bash deploy/gcp-setup.sh
#
# Safe to run again. Needs, before it runs: the Cloud SQL instance treecord-db, the buckets
# treecord-512605-evidence and -keyframes, and these secrets in Secret Manager: database-url, privy-app-secret,
# relayer-private-key, operator-private-key, attester-private-key (the last two are the keys that hold the
# OPERATOR and ATTESTER roles on the Base Sepolia deployment).
# It creates: the runtime service accounts (treecord-api, treecord-worker), the deployer GitHub Actions signs in
# as (only the master branch of meQlause/treecord-backend may), the storage account with its HMAC key (stored as
# the secrets s3-access-key and s3-secret-key), and the bucket CORS rule for uploads from the web app.
set -euo pipefail

PROJECT=treecord-512605
REGION=asia-southeast1
REPO=meQlause/treecord-backend
WEB_ORIGIN=https://treecord-web-631130167814.asia-southeast1.run.app
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
SA() { echo "$1@$PROJECT.iam.gserviceaccount.com"; }

gcloud services enable run.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT"

for account in backend-deployer treecord-api treecord-worker treecord-storage; do
  gcloud iam service-accounts describe "$(SA $account)" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$account" --display-name "$account" --project "$PROJECT"
done

# the deployer: deploy Cloud Run services and jobs, push images, run as the two runtime accounts
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(SA backend-deployer)" \
  --role roles/run.admin --condition None --quiet >/dev/null
gcloud artifacts repositories add-iam-policy-binding treecord --location "$REGION" --project "$PROJECT" \
  --member "serviceAccount:$(SA backend-deployer)" --role roles/artifactregistry.writer --quiet >/dev/null
for runtime in treecord-api treecord-worker; do
  gcloud iam service-accounts add-iam-policy-binding "$(SA $runtime)" --project "$PROJECT" \
    --member "serviceAccount:$(SA backend-deployer)" --role roles/iam.serviceAccountUser --quiet >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$(SA $runtime)" \
    --role roles/cloudsql.client --condition None --quiet >/dev/null
done

# the storage account owns the HMAC key the S3 API signs with (ADR-020), and nothing else
for bucket in evidence keyframes; do
  gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-$bucket" \
    --member "serviceAccount:$(SA treecord-storage)" --role roles/storage.objectAdmin --quiet >/dev/null
done
if ! gcloud secrets describe s3-access-key --project "$PROJECT" >/dev/null 2>&1; then
  KEY_JSON=$(gcloud storage hmac create "$(SA treecord-storage)" --project "$PROJECT" --format=json)
  printf '%s' "$KEY_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).metadata.accessId))" |
    gcloud secrets create s3-access-key --data-file=- --replication-policy=automatic --project "$PROJECT"
  printf '%s' "$KEY_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).secret))" |
    gcloud secrets create s3-secret-key --data-file=- --replication-policy=automatic --project "$PROJECT"
  unset KEY_JSON
fi

# each runtime reads only its own secrets (ADR-014: the API never holds the operator or relayer key)
grant() {
  gcloud secrets add-iam-policy-binding "$2" --project "$PROJECT" \
    --member "serviceAccount:$(SA "$1")" --role roles/secretmanager.secretAccessor --quiet >/dev/null
}
for secret in database-url privy-app-secret attester-private-key s3-access-key s3-secret-key; do grant treecord-api "$secret"; done
for secret in database-url attester-private-key operator-private-key relayer-private-key s3-access-key s3-secret-key; do
  grant treecord-worker "$secret"
done

# the browser uploads evidence with presigned PUT links and reads with presigned GET links
CORS=$(mktemp)
cat >"$CORS" <<JSON
[{"origin": ["$WEB_ORIGIN"], "method": ["GET", "PUT", "HEAD"],
  "responseHeader": ["Content-Type", "Content-Length", "x-amz-checksum-sha256", "ETag"], "maxAgeSeconds": 3600}]
JSON
for bucket in evidence keyframes; do gcloud storage buckets update "gs://$PROJECT-$bucket" --cors-file="$CORS" >/dev/null; done
rm -f "$CORS"

# who may become the deployer: only this repo's master branch, with no stored key
gcloud iam workload-identity-pools providers describe github-backend --location global \
  --workload-identity-pool github --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc github-backend --location global \
    --workload-identity-pool github --project "$PROJECT" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository=='$REPO' && assertion.ref=='refs/heads/master'"
gcloud iam service-accounts add-iam-policy-binding "$(SA backend-deployer)" --project "$PROJECT" \
  --role roles/iam.workloadIdentityUser --quiet >/dev/null \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

echo "Done. A merge to master of $REPO now migrates the database and deploys treecord-api and treecord-worker."
