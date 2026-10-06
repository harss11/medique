-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'OTHER');

-- DropIndex
DROP INDEX "Review_doctorId_idx";

-- DropIndex
DROP INDEX "Review_hospitalId_idx";

-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "hiddenAt" TIMESTAMPTZ(3),
ADD COLUMN     "hiddenReason" TEXT,
ADD COLUMN     "moderatedById" UUID,
ADD COLUMN     "reportReason" TEXT,
ADD COLUMN     "reportedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reportedById" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMonthly" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "maxDoctors" INTEGER,
    "maxStaff" INTEGER,
    "maxMonthlyBookings" INTEGER,
    "analytics" BOOLEAN NOT NULL DEFAULT true,
    "slipPrinting" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "trialEndsAt" TIMESTAMPTZ(3),
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "notes" TEXT,
    "assignedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "method" "SubscriptionPaymentMethod" NOT NULL,
    "reference" TEXT,
    "paidAt" TIMESTAMPTZ(3) NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_hospitalId_key" ON "Subscription"("hospitalId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_subscriptionId_paidAt_idx" ON "SubscriptionPayment"("subscriptionId", "paidAt");

-- CreateIndex
CREATE INDEX "Review_doctorId_isPublished_idx" ON "Review"("doctorId", "isPublished");

-- CreateIndex
CREATE INDEX "Review_hospitalId_isPublished_idx" ON "Review"("hospitalId", "isPublished");

-- CreateIndex
CREATE INDEX "Review_reportedAt_idx" ON "Review"("reportedAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_userId_status_idx" ON "WaitlistEntry"("userId", "status");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Last line of defence for review ratings (the API validates too).
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- Limits can be empty (unlimited) but never negative.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_limits_nonnegative" CHECK (
  "priceMonthly" >= 0
  AND ("maxDoctors" IS NULL OR "maxDoctors" >= 0)
  AND ("maxStaff" IS NULL OR "maxStaff" >= 0)
  AND ("maxMonthlyBookings" IS NULL OR "maxMonthlyBookings" >= 0)
);

-- The free pilot plan: no limits, every feature. Hospitals start on it, so nothing changes for them
-- until an admin moves a hospital to another plan.
INSERT INTO "Plan" ("id", "code", "name", "description", "priceMonthly", "currency", "analytics", "slipPrinting", "isActive", "sortOrder", "updatedAt")
VALUES (gen_random_uuid(), 'pilot', 'Pilot', 'Free during the pilot. No limits.', 0, 'INR', true, true, true, 0, now());

INSERT INTO "Subscription" ("id", "hospitalId", "planId", "status", "updatedAt")
SELECT gen_random_uuid(), h."id", (SELECT "id" FROM "Plan" WHERE "code" = 'pilot'), 'ACTIVE', now()
FROM "Hospital" h
WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."hospitalId" = h."id");
