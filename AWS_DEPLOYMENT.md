# Deploying RHR Booking on AWS

**Status of this document:** written from AWS's own documentation and from the code in this repository. **Nothing here has been run against a real AWS account** (no account or credentials were available), and the Docker image has not been built (no Docker daemon in the development sandbox; CI builds it on every push). Treat the first deployment as a staging exercise and follow §12 to verify it. Places where a command or flag must be checked against your CLI version are marked **[verify]**.

## 1. Prerequisites

- An AWS account with billing enabled and a budget alert (Billing → Budgets → e.g. USD 20/month). **You** create and pay for everything; this repository creates nothing by itself.
- An IAM user/role with permission to create ECR, ECS, RDS, S3, Secrets Manager, IAM roles, CloudWatch and VPC resources (an administrator for the first setup is simplest; do not use the root account for daily work, and turn on MFA).
- AWS CLI v2 configured (`aws configure sso` or `aws configure`), Docker installed locally, Git, Node 22 (only for local checks).
- A domain name (optional but required for your own HTTPS address).
- Pick one region (examples use `ap-south-1`, Mumbai) and use it for everything.

## 2. AWS services and why

| Service | Role | Why this one |
|---|---|---|
| **ECS on Fargate, created with ECS Express Mode** | Runs the container | AWS now recommends Express Mode for new web apps: from an image it creates the Fargate service, an Application Load Balancer with HTTPS, autoscaling and networking. **App Runner is closed to new customers**, so it is not used. No servers to patch. |
| **ECR** | Stores the Docker image | Private registry next to ECS |
| **RDS for PostgreSQL 16** | Database | The app needs PostgreSQL features (GiST exclusion constraint, advisory locks). Single-AZ `db.t4g.micro` is enough to start |
| **S3 (private bucket)** | Hall photos | The app streams images itself (`/uploads/...`), so the bucket stays private; access via the task's IAM role, no keys |
| **Secrets Manager** | Database URL, admin password, SMTP etc. | Keeps secrets out of the image, Git and plain env vars |
| **CloudWatch Logs + alarms** | Logs, health alarms | Container logs go there automatically |
| **ACM + Route 53** | TLS certificate, DNS | Free public certificates; Route 53 only if you host DNS there |

Not used on purpose: CloudFront/S3 static hosting for the front end (the Express app serves the React build itself, so there is one deployable and no CORS), Elastic Beanstalk, Kubernetes.

**Fallback if Express Mode is unavailable in your account/region:** a plain ECS Fargate service behind an ALB, or one small EC2 instance running `docker compose` with a reverse proxy. The image and environment variables are identical; only the hosting steps differ.

## 3. Architecture

```
Browser ──HTTPS──► Application Load Balancer (ACM certificate)
                        │
                        ▼
              ECS Fargate task (this image, port 3001)
              ├── serves React build + /api
              ├──► RDS PostgreSQL  (private subnets, TLS verified with the RDS CA bundle)
              ├──► S3 bucket       (private, task IAM role)
              └──► Secrets Manager (injected as environment variables at start)
Logs ► CloudWatch
```

The database must **not** be publicly accessible. Its security group allows port 5432 only from the service's security group.

## 4. RDS PostgreSQL

1. RDS → Create database → Standard create → PostgreSQL **16** → template **Dev/Test** (or Free tier if offered).
2. Single-AZ, `db.t4g.micro`, 20 GB gp3, **Public access: No**, same VPC as the service.
3. Master username e.g. `rhr_admin`; let RDS generate and store the password in Secrets Manager (or set a strong one yourself). Initial database name `rhr`.
4. Enable automated backups (retention ≥ 7 days) and deletion protection.
5. Security group: inbound TCP 5432 from the **service's** security group only.
6. Connection string (URL-encode special characters in the password):
   `postgres://rhr_admin:<password>@<endpoint>:5432/rhr`
7. The Docker image contains AWS's RDS CA bundle at `/app/certs/rds-global-bundle.pem`. Set `DATABASE_SSL_CA_FILE` to that path; the app then verifies the server certificate.
   (The bundle is downloaded from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` during `docker build` — **[verify]** the URL still works; the build fails loudly if it does not.)
8. `MIGRATE_DATABASE_URL` is not needed with RDS (no pooler); leave it empty.

## 5. S3 bucket (private)

1. S3 → Create bucket, e.g. `rhr-booking-images-<your-account-suffix>`, same region.
2. **Block all public access: ON** (all four boxes). Default encryption SSE-S3. Versioning: optional.
3. Create an IAM policy for the app, attached to the **task role** (not a user, no access keys):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::YOUR_BUCKET/*"
  }]
}
```
4. Set `STORAGE_DRIVER=s3`, `S3_BUCKET=<name>`, `AWS_REGION=<region>`. Leave `S3_ENDPOINT` empty. The app uses the default AWS credential chain, so the task role is picked up automatically.

## 6. Backend deployment (ECR + ECS Express Mode)

**6.1 Build and push the image**
```bash
export AWS_REGION=ap-south-1
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export REPO=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/rhr-booking

aws ecr create-repository --repository-name rhr-booking --image-scanning-configuration scanOnPush=true
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com
docker build -t $REPO:v1 .
docker push $REPO:v1
```
Use a new tag per release (`v1`, `v2`, or the Git SHA) — never rely on `latest`, so rollback is possible.

**6.2 Secrets** (Secrets Manager → Store a new secret → "Other type"; or CLI). Create one secret per value:
```bash
aws secretsmanager create-secret --name rhr/DATABASE_URL    --secret-string 'postgres://…'
aws secretsmanager create-secret --name rhr/ADMIN_PASSWORD  --secret-string '<strong password, 10+ chars, letters and numbers>'
```
Type the values yourself; do not paste them into chat or commit them.

**6.3 IAM roles** (Express Mode needs these) **[verify names in the console wizard]**
- **Task execution role** — pulls the image from ECR, writes logs, and reads the secrets above (add `secretsmanager:GetSecretValue` on `rhr/*`). Start from the managed policy `AmazonECSTaskExecutionRolePolicy`.
- **Infrastructure role** — lets ECS create the load balancer, security groups and scaling. Use the managed role the Express Mode console wizard offers to create.
- **Task role** — the S3 policy from §5 (this is what the running app uses).

**6.4 Create the service.** Easiest: ECS console → **Create → Express Mode service** (choose the image, port `3001`, health check path `/healthz`, 1 vCPU / 2 GB is plenty, min 1 task, max 2). CLI equivalent **[verify flags with `aws ecs create-express-gateway-service help`; this is not tested here]**:
```bash
aws ecs create-express-gateway-service \
  --service-name rhr-booking \
  --execution-role-arn  arn:aws:iam::$ACCOUNT:role/<task-execution-role> \
  --infrastructure-role-arn arn:aws:iam::$ACCOUNT:role/<infrastructure-role> \
  --health-check-path /healthz \
  --scaling-target '{"minTaskCount":1,"maxTaskCount":2}' \
  --primary-container '{"image":"'$REPO':v1","containerPort":3001, ... environment and secrets from §8 ...}' \
  --monitor-resources
```
Attach the task role (§5) and make sure the service's security group is the one allowed into RDS (§4). If the wizard cannot attach a task role or secrets, use the fallback in §2.

**Keep `desiredCount`/max at 1–2.** The notification worker runs inside every task; two tasks are safe (queue claims use row locks) but one is simplest.

## 7. Frontend deployment

There is no separate frontend deployment: `npm run build` runs inside the Docker build and the Express server serves `dist/` (single-page-app fallback included) from the same origin as `/api`. This avoids CORS and cookie-domain problems. If you later want CloudFront in front, point it at the load balancer and forward cookies and the `X-Requested-With` header.

## 8. Environment variables

Plain values (environment) and secrets (Secrets Manager → injected). The full commented list is in `.env.example`.

| Variable | Value | Secret? |
|---|---|---|
| `NODE_ENV` | `production` (already set in the image) | no |
| `PORT` | `3001` | no |
| `DATABASE_URL` | RDS connection string | **yes** |
| `DATABASE_SSL_CA_FILE` | `/app/certs/rds-global-bundle.pem` | no |
| `DB_POOL_MAX` | `10` | no |
| `STORAGE_DRIVER` | `s3` | no |
| `S3_BUCKET`, `AWS_REGION` | bucket name, region | no |
| `TRUST_PROXY` | `true` (behind the load balancer; otherwise rate limits/lockouts see one IP) | no |
| `COOKIE_SECURE` | `true` | no |
| `ADMIN_USERNAME` | first admin's username | no |
| `ADMIN_PASSWORD` | first admin's password | **yes** (remove after first login) |
| `SESSION_HOURS` | `12` | no |
| `SMTP_*`, `TWILIO_*`, `WHATSAPP_*`, `PAYMENT_WEBHOOK_SECRET` | optional; blank = test mode, nothing is sent | **yes** |

The server refuses to start in production if `DATABASE_URL` is missing or contains a placeholder/dev password, if `STORAGE_DRIVER=s3` lacks bucket/region, or if the CA file path does not exist. `UPLOAD_DIR`/`BACKUP_DIR` are only used by the `local` driver.

## 9. Database migrations

Migrations are applied automatically on every start (advisory-locked, so two tasks starting together are safe) and a failed migration stops the container before it serves traffic — in Express Mode/ECS the previous task keeps running while the new one fails its health check. Applied migration files must never be edited (checksums are verified).

Manual run from a machine that can reach the database (e.g. a one-off ECS task using the same image and secrets):
`node server/scripts/migrate.js`. **Always take a snapshot first** (§14): migrations are forward-only.

## 10. Initial admin

If the `users` table is empty on start, the server creates the admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (weak passwords stop the start-up). Log in, create real accounts under **More → Users & roles**, change the admin password, then **remove `ADMIN_PASSWORD` from the service configuration and redeploy**. To reset later, run a one-off task with the image: `node server/scripts/create-admin.js <username> <new-password> "Full Name" admin` (same as `npm run create-admin`).

## 11. HTTPS and domain

Express Mode gives the service an HTTPS URL on an AWS domain with a certificate. For your own domain:
1. ACM → Request a public certificate for `booking.yourdomain.com` (same region as the load balancer), validate by the DNS record it shows.
2. Attach it to the load balancer's HTTPS listener (HTTP → HTTPS redirect on port 80) **[verify how Express Mode exposes custom domains in your console]**.
3. Route 53 (or your DNS host): CNAME/alias `booking.yourdomain.com` → the load balancer DNS name.
Keep `COOKIE_SECURE=true`; the app sets HSTS and security headers itself.

## 12. Testing the deployed app

1. `https://<host>/healthz` → `{"ok":true}`; `https://<host>/api/health` → `{"ok":true,…}` (checks the database).
2. Log in as the admin. Wrong password is refused with a generic message.
3. Create a hall, upload a photo. The image must load from `https://<host>/uploads/halls/…` and the object must appear in the S3 bucket. In S3 → bucket → Permissions confirm "Block public access" is on and the object URL opened directly is **denied**.
4. Create a customer booking; try an overlapping one (must be refused); record an advance + final payment; open the bill PDF; check Reports and the Dashboard totals.
5. Cancel the test booking; log out; open a deep link — you must see the login screen.
6. Restart/redeploy the service (§15) and confirm the photo and data are still there.
7. Optionally point the repository's Playwright scripts at the deployed URL **against a throw-away database only**.

## 13. Logs and monitoring

- Logs: CloudWatch → Log groups → the service's group (container stdout). Look for `RHR server listening` and any `FATAL`/`Migration … failed`.
- Alarms (CloudWatch): ALB `HTTPCode_Target_5XX_Count` > 5 in 5 min; ALB `UnHealthyHostCount` ≥ 1; RDS `FreeStorageSpace` < 3 GB; RDS `CPUUtilization` > 80 % for 15 min; RDS `DatabaseConnections` near the limit. Send to an SNS e-mail topic.
- Optional: an external uptime check on `/healthz`.

## 14. Backup and recovery

- **RDS automated backups** + point-in-time restore (set retention ≥ 7 days). Take a **manual snapshot before every release that adds a migration**.
- **Logical backup** (independent of AWS): from a machine that can reach the DB, `DATABASE_URL=… BACKUP_DIR=./backups npm run backup`; keep the folder off the machine. Verify a backup with `npm run restore -- ./backups/<folder> --verify` against a local PostgreSQL.
- **S3 photos:** turn on bucket versioning (cheap) or copy the bucket periodically (`aws s3 sync`). Photos can also be re-uploaded.
- **Recovery drill:** restore a snapshot into a *new* RDS instance, point a staging service at it, run §12. Do this once before real use.

## 15. Redeploy and rollback

Redeploy: build and push a new tag (§6.1) → update the service to the new image (console, or `aws ecs update-express-gateway-service` **[verify]**) → watch the logs and `/healthz`.
Rollback: update the service back to the previous image tag. Code rollback does **not** undo database migrations — if the release added one, restore from the pre-release snapshot only if the old code cannot run on the new schema.
CI (`.github/workflows/ci.yml`) runs lint, backend tests, frontend tests, build, `npm audit` and a Docker build on every push. It does not deploy.

## 16. Cost and free-tier caveats

Prices change — use the AWS Pricing Calculator for your region and check the current Free Tier page. What is true by design:
- New AWS accounts currently receive sign-up credits (up to roughly USD 200 if you complete activities) with a free plan that ends after 6 months or when credits run out **[verify on aws.amazon.com/free]**. After that you pay.
- **Always-on costs even when idle:** the Application Load Balancer (hourly + usage), Fargate task (vCPU/GB-hours), RDS instance + storage, any NAT gateway (avoid: use public subnets for the service with a locked-down security group, or VPC endpoints, since a NAT gateway is a frequent surprise), CloudWatch logs, Secrets Manager (per secret per month), public IPv4 addresses.
- Cheapest simplest alternative: one small EC2 instance with Docker Compose and RDS or a containerised Postgres (no ALB) — cheaper but you patch and secure the server and manage TLS yourself.
- Set a budget alert before creating anything, and delete the stack (service, ALB, RDS with a final snapshot, ECR images, S3 bucket, secrets) if you stop using it.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Task starts then stops, logs show `FATAL: DATABASE_URL …` | Secret not injected, or still a placeholder |
| `Cannot connect to the database after 6 attempts` | Security group does not allow the service → RDS on 5432; wrong endpoint; RDS in other VPC |
| `self-signed certificate in certificate chain` | `DATABASE_SSL_CA_FILE` not set / wrong path; RDS CA bundle missing from image |
| `Migration NNN failed` | Read the message; restore the snapshot if partially applied (each migration is a transaction, so normally nothing is half-applied) |
| `STORAGE_DRIVER=s3 needs …` | `S3_BUCKET`/`AWS_REGION` missing |
| Upload fails with `S3 upload failed (AccessDenied)` | Task role missing the S3 policy, or policy bucket name wrong |
| Images 404 but upload worked | Different bucket/region configured than the one uploaded to; object key under `halls/` missing |
| Health check failing, task replaced repeatedly | Health path must be `/healthz`, port `3001`; start-up (DB wait + migrations) can take ~30 s — give a grace period |
| Everyone gets "too many attempts" | `TRUST_PROXY` not `true` |
| Logged out immediately | `COOKIE_SECURE=true` over plain HTTP; use the HTTPS URL |
| `ResourceInitializationError` pulling secrets/image | Execution role lacks ECR/Secrets Manager permissions, or the task has no route to the internet/VPC endpoints |
| No e-mails | SMTP not configured (test mode); AWS blocks outbound port 25 by default — use 587 or Amazon SES **[verify]** |
